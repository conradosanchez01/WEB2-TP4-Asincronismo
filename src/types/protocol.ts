/**
 * Contrato de mensajes del protocolo WebSocket (versión inicial: ingreso y participantes).
 * Centralizar los tipos acá garantiza que el validador, el servidor y la lógica
 * hablen exactamente el mismo idioma en tiempo de compilación.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 20;

export type ServerErrorCode =
  | 'INVALID_JSON'
  | 'UNKNOWN_TYPE'
  | 'INVALID_PAYLOAD'
  | 'NOT_JOINED'
  | 'ALREADY_JOINED'
  | 'NAME_TAKEN';

/* ============================================================================
 * Mensajes WebSocket: Cliente (Participante) -> Servidor
 * ============================================================================ */

/** Solicitud inicial del participante para registrarse con un nombre visible. */
export interface JoinMessage {
  type: 'join';
  name: string;
}

/** Unión discriminada de todos los mensajes válidos que puede enviar un cliente. */
export type ClientMessage = JoinMessage;

/* ============================================================================
 * Mensajes WebSocket: Servidor -> Cliente (Participante)
 * ============================================================================ */

/**
 * Respuesta privada al participante que acaba de ingresar correctamente.
 * Le entrega su nombre confirmado y la foto actual de quiénes están conectados.
 */
export interface WelcomeMessage {
  type: 'welcome';
  you: string;
  participants: string[];
}

/**
 * Notificación enviada a todos los participantes cuando alguien entra o se desconecta.
 */
export interface ParticipantsUpdatedMessage {
  type: 'participants_updated';
  participants: string[];
  event: 'joined' | 'left';
  participant: string;
}

/**
 * Error privado enviado únicamente al cliente que mandó un mensaje inválido
 * o pidió una acción no permitida (nunca afecta ni se muestra a los demás).
 */
export interface ErrorMessage {
  type: 'error';
  code: ServerErrorCode;
  message: string;
}

/** Unión discriminada de todos los mensajes que el servidor puede emitir por WebSocket. */
export type ServerMessage =
  | WelcomeMessage
  | ParticipantsUpdatedMessage
  | ErrorMessage;
