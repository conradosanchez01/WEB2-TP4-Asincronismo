/**
 * Contrato de mensajes del protocolo WebSocket.
 * Centralizar los tipos acá garantiza que el validador, el servidor y la lógica
 * hablen exactamente el mismo idioma en tiempo de compilación.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 20;
export const MAX_PROPOSAL_IDS = 10;

/** Representación pública de un producto en la lista compartida (datos originados en el servidor). */
export interface ProductItem {
  id: number;
  title: string;
  price: number;
  image: string;
  proposedBy: string;
  addedAt: number;
}

/** Motivos posibles por los que un ID de una propuesta no pudo agregarse. */
export type ProposalFailureReason =
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'ALREADY_EXISTS'
  | 'DUPLICATE_IN_REQUEST'
  | 'CATALOG_ERROR';

/** Detalle de un fallo parcial dentro de una propuesta de productos. */
export interface ProposalFailure {
  productId: number;
  reason: ProposalFailureReason;
  message: string;
}

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

/** Solicitud para agregar entre 1 y 10 productos consultando sus IDs en el catálogo externo. */
export interface ProposeProductsMessage {
  type: 'propose_products';
  productIds: number[];
  /** Identificador opcional enviado por el cliente para correlacionar propuestas pendientes. */
  requestId?: string;
}

/** Unión discriminada de todos los mensajes válidos que puede enviar un cliente. */
export type ClientMessage = JoinMessage | ProposeProductsMessage;

/* ============================================================================
 * Mensajes WebSocket: Servidor -> Cliente (Participante)
 * ============================================================================ */

/**
 * Respuesta privada al participante que acaba de ingresar correctamente.
 * Le entrega su nombre confirmado, quiénes están conectados y la lista completa de productos.
 */
export interface WelcomeMessage {
  type: 'welcome';
  you: string;
  participants: string[];
  products: ProductItem[];
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

export type ListUpdateReason = 'products_added';

/**
 * Broadcast enviado a todos los participantes cuando la lista compartida cambia efectivamente.
 */
export interface ListUpdatedMessage {
  type: 'list_updated';
  products: ProductItem[];
  reason: ListUpdateReason;
  actor: string;
}

/**
 * Respuesta privada enviada ÚNICAMENTE al participante que envió una propuesta.
 * Informa qué productos se agregaron y el motivo exacto de cada fallo parcial.
 */
export interface ProposalResultMessage {
  type: 'proposal_result';
  requestId?: string;
  added: ProductItem[];
  failed: ProposalFailure[];
}

/**
 * Error privado enviado únicamente al cliente que mandó un mensaje inválido
 * o pidió una acción no permitida (nunca afecta ni se muestra a los demás).
 */
export interface ErrorMessage {
  type: 'error';
  code: ServerErrorCode;
  message: string;
  /** Si el mensaje rechazado traía un requestId válido, se devuelve para limpiar estados pendientes en el cliente. */
  requestId?: string;
}

/** Unión discriminada de todos los mensajes que el servidor puede emitir por WebSocket. */
export type ServerMessage =
  | WelcomeMessage
  | ParticipantsUpdatedMessage
  | ListUpdatedMessage
  | ProposalResultMessage
  | ErrorMessage;
