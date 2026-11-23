import { ServerErrorCode } from '../types/protocol.js';
import { normalizeName } from '../validation/messageValidator.js';

/** Resultado de una operación sobre el estado en memoria. */
export type StoreActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

/**
 * Almacén en memoria de la aplicación (sin base de datos).
 * En esta primera versión administra únicamente los participantes conectados;
 * en próximos pasos incorporará productos, votos y ranking.
 */
export class GiftListStore {
  // Mapa: nombre normalizado (minúsculas) -> nombre visible elegido por el usuario.
  private readonly participants = new Map<string, string>();

  /**
   * Registra un participante si su nombre no está ocupado por otro usuario conectado.
   * La búsqueda por clave normalizada impide duplicados como "Ana" y "ana".
   */
  addParticipant(displayName: string): StoreActionResult<string> {
    const key = normalizeName(displayName);
    if (this.participants.has(key)) {
      return {
        ok: false,
        code: 'NAME_TAKEN',
        message: `El nombre "${displayName}" ya está en uso por otro participante conectado.`,
      };
    }

    this.participants.set(key, displayName);
    return { ok: true, value: displayName };
  }

  /**
   * Elimina a un participante cuando cierra su conexión, liberando su nombre
   * para que pueda volver a utilizarse luego.
   */
  removeParticipant(displayName: string): boolean {
    return this.participants.delete(normalizeName(displayName));
  }

  /** Devuelve la lista actual de nombres visibles de los participantes conectados. */
  getParticipants(): string[] {
    return Array.from(this.participants.values());
  }

  /** Devuelve cuántos participantes hay conectados en este momento. */
  getParticipantsCount(): number {
    return this.participants.size;
  }
}
