import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { GiftListStore } from '../services/giftListStore.js';
import {
  ClientMessage,
  ServerErrorCode,
  ServerMessage,
} from '../types/protocol.js';
import { parseAndValidateClientMessage } from '../validation/messageValidator.js';

/** Estado asociado a cada conexión WebSocket individual mientras permanezca abierta. */
interface ClientSession {
  ws: WebSocket;
  /** Es null mientras el cliente conectó el socket pero todavía no envió "join". */
  name: string | null;
  /** Bandera para garantizar que la limpieza al cerrar se ejecute una sola vez. */
  cleanedUp: boolean;
}

/** Límite máximo de tamaño por mensaje entrante (16 KB) para proteger la memoria del servidor. */
const MAX_WS_PAYLOAD_BYTES = 16 * 1024;

/**
 * Administra las conexiones WebSocket de los participantes, valida los mensajes
 * entrantes, coordina los broadcasts y libera recursos cuando alguien cierra la pestaña.
 */
export class WsHandler {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, ClientSession>();

  constructor(private readonly store: GiftListStore) {
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

  /** Cierra ordenadamente todas las conexiones activas cuando se detiene el servidor. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
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
      cleanedUp: false,
    };

    this.sessions.set(ws, session);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        this.onMessage(session, data, isBinary);
      } catch (err) {
        // Red de seguridad: ningún mensaje entrante debe poder tumbar el servidor.
        console.error('[ws] Error inesperado procesando mensaje:', err);
        this.sendError(
          ws,
          'INVALID_PAYLOAD',
          'Ocurrió un error interno al procesar el mensaje.'
        );
      }
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
  private onMessage(
    session: ClientSession,
    data: RawData,
    isBinary: boolean
  ): void {
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
      this.sendError(session.ws, parsed.code, parsed.message);
      return;
    }

    this.dispatchMessage(session, parsed.value);
  }

  /** Deriva el mensaje ya validado al manejador correspondiente según su tipo. */
  private dispatchMessage(session: ClientSession, message: ClientMessage): void {
    switch (message.type) {
      case 'join':
        this.handleJoin(session, message.name);
        return;
    }
  }

  /**
   * Registra al participante en memoria, le envía el estado actual ("welcome")
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

    // Quien entra recibe de inmediato su confirmación y la lista actual de conectados.
    this.send(session.ws, {
      type: 'welcome',
      you: session.name,
      participants: this.store.getParticipants(),
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
   * Libera la sesión cuando se cierra la pestaña o falla el socket,
   * quita al participante del estado y notifica al resto.
   */
  private cleanupSession(session: ClientSession): void {
    if (session.cleanedUp) {
      return;
    }
    session.cleanedUp = true;

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
  private sendError(ws: WebSocket, code: ServerErrorCode, message: string): void {
    this.send(ws, { type: 'error', code, message });
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
