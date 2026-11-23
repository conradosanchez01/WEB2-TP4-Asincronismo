import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { CatalogService } from '../services/catalogService.js';
import { GiftListStore } from '../services/giftListStore.js';
import {
  ClientMessage,
  ProductItem,
  ProposalFailure,
  ServerErrorCode,
  ServerMessage,
} from '../types/protocol.js';
import { parseAndValidateClientMessage } from '../validation/messageValidator.js';

/** Estado asociado a cada conexión WebSocket individual mientras permanezca abierta. */
interface ClientSession {
  ws: WebSocket;
  /** Es null mientras el cliente conectó el socket pero todavía no envió "join". */
  name: string | null;
  /** Se aborta al cerrar el socket para cancelar cualquier consulta al catálogo que siga en curso. */
  disconnectController: AbortController;
  /** Bandera para garantizar que la limpieza al cerrar se ejecute una sola vez. */
  cleanedUp: boolean;
}

/** Límite máximo de tamaño por mensaje entrante (16 KB) para proteger la memoria del servidor. */
const MAX_WS_PAYLOAD_BYTES = 16 * 1024;

/**
 * Administra las conexiones WebSocket de los participantes, valida los mensajes
 * entrantes, coordina consultas al catálogo y broadcasts, y libera recursos al cerrar.
 */
export class WsHandler {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, ClientSession>();

  constructor(
    private readonly store: GiftListStore,
    private readonly catalog: CatalogService
  ) {
    // noServer: true permite acoplar WebSocket al mismo servidor HTTP y puerto.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    });

    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /**
   * Completa el handshake HTTP -> WebSocket cuando llega un evento "upgrade" en /ws.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /** Cierra ordenadamente todas las conexiones y aborta consultas en vuelo al apagar el servidor. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.disconnectController.abort();
      if (
        session.ws.readyState === WebSocket.OPEN ||
        session.ws.readyState === WebSocket.CONNECTING
      ) {
        session.ws.close(1001, 'Servidor cerrándose');
      }
    }
    this.sessions.clear();
    this.wss.close();
  }

  /** Inicializa la sesión y los listeners para un nuevo cliente WebSocket conectado. */
  private onConnection(ws: WebSocket): void {
    const session: ClientSession = {
      ws,
      name: null,
      disconnectController: new AbortController(),
      cleanedUp: false,
    };

    this.sessions.set(ws, session);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Atrapamos tanto errores síncronos como promesas rechazadas para que el servidor nunca caiga.
      void this.onMessage(session, data, isBinary).catch((err) => {
        console.error('[ws] Error inesperado procesando mensaje:', err);
        this.sendError(
          ws,
          'INVALID_PAYLOAD',
          'Ocurrió un error interno al procesar el mensaje.'
        );
      });
    });

    ws.on('close', () => {
      this.cleanupSession(session);
    });

    ws.on('error', (err) => {
      console.error('[ws] Error en conexión WebSocket:', err.message);
      this.cleanupSession(session);
    });
  }

  /** Valida que el mensaje sea texto JSON conforme al contrato antes de despacharlo. */
  private async onMessage(
    session: ClientSession,
    data: RawData,
    isBinary: boolean
  ): Promise<void> {
    if (isBinary) {
      this.sendError(
        session.ws,
        'INVALID_JSON',
        'Solo se aceptan mensajes de texto en formato JSON.'
      );
      return;
    }

    const rawText = rawDataToString(data);
    const parsed = parseAndValidateClientMessage(rawText);

    if (!parsed.ok) {
      this.sendError(session.ws, parsed.code, parsed.message, parsed.requestId);
      return;
    }

    await this.dispatchMessage(session, parsed.value);
  }

  /**
   * Deriva el mensaje validado al manejador correspondiente.
   * Exige haber completado "join" antes de permitir cualquier otra acción.
   */
  private async dispatchMessage(
    session: ClientSession,
    message: ClientMessage
  ): Promise<void> {
    if (message.type === 'join') {
      this.handleJoin(session, message.name);
      return;
    }

    if (session.name === null) {
      const requestId =
        message.type === 'propose_products' ? message.requestId : undefined;
      this.sendError(
        session.ws,
        'NOT_JOINED',
        'Debés ingresar un nombre ("join") antes de enviar acciones.',
        requestId
      );
      return;
    }

    switch (message.type) {
      case 'propose_products':
        await this.handleProposeProducts(
          session,
          session.name,
          message.productIds,
          message.requestId
        );
        return;

      case 'vote':
        this.handleVote(session, session.name, message.productId);
        return;

      case 'unvote':
        this.handleUnvote(session, session.name, message.productId);
        return;

      case 'remove_product':
        this.handleRemoveProduct(session, session.name, message.productId);
        return;
    }
  }

  /**
   * Registra al participante en memoria, le envía el estado completo actual ("welcome")
   * y avisa a los demás conectados que se sumó una persona.
   */
  private handleJoin(session: ClientSession, name: string): void {
    if (session.name !== null) {
      this.sendError(
        session.ws,
        'ALREADY_JOINED',
        `Ya estás conectado como "${session.name}".`
      );
      return;
    }

    const result = this.store.addParticipant(name);
    if (!result.ok) {
      this.sendError(session.ws, result.code, result.message);
      return;
    }

    session.name = result.value;

    // Quien entra recibe de inmediato los participantes y el ranking completo actual.
    this.send(session.ws, {
      type: 'welcome',
      you: session.name,
      participants: this.store.getParticipants(),
      products: this.store.getRankedProducts(),
    });

    // Los demás participantes ya unidos reciben el aviso de ingreso.
    this.broadcastToJoined(
      {
        type: 'participants_updated',
        participants: this.store.getParticipants(),
        event: 'joined',
        participant: session.name,
      },
      session.ws
    );
  }

  /**
   * Procesa una propuesta de 1 a 10 productos:
   * 1) Descarta al instante IDs repetidos en el mismo envío o ya existentes en la lista.
   * 2) Consulta el resto en paralelo a DummyJSON (sin bloquear a otros participantes).
   * 3) Inserta atómicamente los válidos (protección frente a propuestas simultáneas).
   * 4) Envía el detalle de éxitos y fallos SOLO al autor; difunde la lista solo si se agregó algo.
   */
  private async handleProposeProducts(
    session: ClientSession,
    actorName: string,
    productIds: number[],
    requestId?: string
  ): Promise<void> {
    const failures: ProposalFailure[] = [];
    const seenInRequest = new Set<number>();
    const idsToFetch: number[] = [];

    for (const id of productIds) {
      if (seenInRequest.has(id)) {
        failures.push({
          productId: id,
          reason: 'DUPLICATE_IN_REQUEST',
          message: `El producto #${id} está repetido dentro de la misma propuesta.`,
        });
        continue;
      }
      seenInRequest.add(id);

      if (this.store.hasProduct(id)) {
        failures.push({
          productId: id,
          reason: 'ALREADY_EXISTS',
          message: `El producto #${id} ya está en la lista.`,
        });
        continue;
      }

      idsToFetch.push(id);
    }

    const added: ProductItem[] = [];

    if (idsToFetch.length > 0) {
      // Mientras este await espera al catálogo externo, el Event Loop sigue libre para otros clientes.
      const fetchResults = await this.catalog.fetchProductsInParallel(
        idsToFetch,
        session.disconnectController.signal
      );

      // Si el cliente cerró la pestaña antes de que volviera la respuesta, no enviamos nada.
      if (
        session.cleanedUp ||
        session.disconnectController.signal.aborted ||
        session.ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      for (const { productId, result } of fetchResults) {
        if (!result.ok) {
          if (!result.abortedByDisconnect) {
            failures.push(result.failure);
          }
          continue;
        }

        // Chequeo e inserción atómica: evita duplicados si otro usuario propuso el mismo ID a la vez.
        const insertResult = this.store.addProduct(result.product, actorName);
        if (!insertResult.ok) {
          failures.push({
            productId,
            reason: 'ALREADY_EXISTS',
            message: `El producto #${productId} ya fue agregado a la lista por otro participante.`,
          });
        } else {
          added.push(insertResult.product);
        }
      }
    }

    // Resultado detallado privado: los errores ajenos nunca se envían a los demás participantes.
    this.send(session.ws, {
      type: 'proposal_result',
      ...(requestId !== undefined ? { requestId } : {}),
      added,
      failed: failures,
    });

    // Solo difundimos el nuevo ranking si efectivamente se incorporó al menos un producto.
    if (added.length > 0) {
      this.broadcastToJoined({
        type: 'list_updated',
        products: this.store.getRankedProducts(),
        reason: 'products_added',
        actor: actorName,
      });
    }
  }

  /** Registra un voto y difunde el ranking reordenado a todos los participantes. */
  private handleVote(
    session: ClientSession,
    actorName: string,
    productId: number
  ): void {
    const result = this.store.vote(productId, actorName);
    if (!result.ok) {
      this.sendError(session.ws, result.code, result.message);
      return;
    }

    this.broadcastToJoined({
      type: 'list_updated',
      products: this.store.getRankedProducts(),
      reason: 'vote_added',
      actor: actorName,
    });
  }

  /** Retira un voto existente y difunde el ranking reordenado a todos los participantes. */
  private handleUnvote(
    session: ClientSession,
    actorName: string,
    productId: number
  ): void {
    const result = this.store.unvote(productId, actorName);
    if (!result.ok) {
      this.sendError(session.ws, result.code, result.message);
      return;
    }

    this.broadcastToJoined({
      type: 'list_updated',
      products: this.store.getRankedProducts(),
      reason: 'vote_removed',
      actor: actorName,
    });
  }

  /**
   * Quita un producto si el solicitante es su autor; caso contrario responde FORBIDDEN
   * únicamente al solicitante sin alterar la lista.
   */
  private handleRemoveProduct(
    session: ClientSession,
    actorName: string,
    productId: number
  ): void {
    const result = this.store.removeProduct(productId, actorName);
    if (!result.ok) {
      this.sendError(session.ws, result.code, result.message);
      return;
    }

    this.broadcastToJoined({
      type: 'list_updated',
      products: this.store.getRankedProducts(),
      reason: 'product_removed',
      actor: actorName,
    });
  }

  /**
   * Libera la sesión cuando se cierra la pestaña o falla el socket,
   * cancela consultas al catálogo en vuelo, quita al participante y avisa al resto.
   */
  private cleanupSession(session: ClientSession): void {
    if (session.cleanedUp) {
      return;
    }
    session.cleanedUp = true;

    // Aborta cualquier fetch pendiente que haya disparado esta conexión.
    session.disconnectController.abort();
    this.sessions.delete(session.ws);

    if (session.name !== null) {
      const departedName = session.name;
      session.name = null;
      const removed = this.store.removeParticipant(departedName);

      if (removed) {
        this.broadcastToJoined({
          type: 'participants_updated',
          participants: this.store.getParticipants(),
          event: 'left',
          participant: departedName,
        });
      }
    }
  }

  /**
   * Envía un mensaje JSON a todos los participantes que ya completaron "join"
   * y tienen su conexión abierta, excluyendo opcionalmente a un socket.
   */
  private broadcastToJoined(message: ServerMessage, exclude?: WebSocket): void {
    const serialized = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (session.name === null || session.ws === exclude) {
        continue;
      }
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(serialized);
      }
    }
  }

  /** Envía un mensaje de error únicamente al cliente que disparó el problema. */
  private sendError(
    ws: WebSocket,
    code: ServerErrorCode,
    message: string,
    requestId?: string
  ): void {
    this.send(ws, {
      type: 'error',
      code,
      message,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  /** Envía un mensaje tipado a un único socket verificando que siga abierto. */
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

/** Convierte los distintos formatos posibles de RawData de "ws" en texto UTF-8. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}
