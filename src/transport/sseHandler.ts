import { IncomingMessage, ServerResponse } from 'node:http';
import { GiftListStore } from '../services/giftListStore.js';
import { ScreenEventMap, ScreenEventName } from '../types/protocol.js';

/**
 * Administra las conexiones unidireccionales Server-Sent Events (SSE) de las pantallas.
 * La pantalla solo recibe novedades desde el servidor (ranking y cantidad de participantes)
 * sin enviar nunca mensajes de vuelta.
 */
export class SseHandler {
  /** Conjunto de respuestas HTTP mantenidas abiertas como streams text/event-stream. */
  private readonly clients = new Set<ServerResponse>();

  constructor(private readonly store: GiftListStore) {}

  /**
   * Abre un stream SSE para una pantalla que se conecta a GET /events:
   * configura las cabeceras estándar, registra la limpieza al cerrar la pestaña
   * y envía inmediatamente el estado completo inicial ("snapshot").
   */
  handleConnection(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    this.clients.add(res);

    const cleanup = () => {
      this.clients.delete(res);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    // Entrega inmediata del estado actual para no quedar vacía esperando un cambio
    this.sendEvent(res, 'snapshot', {
      participantsCount: this.store.getParticipantsCount(),
      products: this.store.getScreenProducts(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Difunde el ranking actualizado a todas las pantallas conectadas. */
  broadcastRanking(): void {
    this.broadcast('ranking_updated', {
      participantsCount: this.store.getParticipantsCount(),
      products: this.store.getScreenProducts(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Difunde el contador de participantes conectados cuando alguien entra o se va. */
  broadcastParticipantsCount(): void {
    this.broadcast('participants_updated', {
      participantsCount: this.store.getParticipantsCount(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Cierra ordenadamente todos los streams SSE activos al detener el servidor. */
  closeAll(): void {
    for (const res of this.clients) {
      if (!res.writableEnded) {
        res.end();
      }
    }
    this.clients.clear();
  }

  /** Envía un evento tipado a todas las pantallas actualmente suscriptas. */
  private broadcast<E extends ScreenEventName>(
    eventName: E,
    payload: ScreenEventMap[E]
  ): void {
    for (const res of this.clients) {
      this.sendEvent(res, eventName, payload);
    }
  }

  /**
   * Serializa y escribe un evento con el formato estándar del protocolo SSE:
   *   event: <nombre>
   *   data: <json>
   *   (línea en blanco delimitadora)
   */
  private sendEvent<E extends ScreenEventName>(
    res: ServerResponse,
    eventName: E,
    payload: ScreenEventMap[E]
  ): void {
    if (res.writableEnded || res.destroyed) {
      this.clients.delete(res);
      return;
    }

    try {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }
}
