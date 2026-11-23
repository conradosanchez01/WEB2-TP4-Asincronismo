import {
  ClientMessage,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  ServerErrorCode,
} from '../types/protocol.js';

/**
 * Resultado estructurado de una validación.
 * Evita lanzar excepciones para errores esperables de entrada de usuarios.
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

/** Detecta caracteres de control invisibles (saltos de línea, tabs raros, NULL, etc.). */
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;

/**
 * Limpia espacios al principio/fin y colapsa múltiples espacios internos en uno solo.
 * Ej: "  Ana   Paz  " -> "Ana Paz".
 */
export function cleanDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Normaliza un nombre para comparaciones de unicidad sin distinguir mayúsculas/minúsculas.
 * Así evitamos que coexistan "Ana" y "ana" como dos participantes distintos.
 */
export function normalizeName(name: string): string {
  return cleanDisplayName(name).toLowerCase();
}

/**
 * Valida las reglas de negocio definidas para el nombre de un participante:
 * obligatorio, texto sin caracteres de control y entre 2 y 20 caracteres visibles.
 */
export function validateParticipantName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'El campo "name" es obligatorio y debe ser una cadena de texto.',
    };
  }

  if (CONTROL_CHARS_REGEX.test(raw)) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'El nombre contiene caracteres no permitidos.',
    };
  }

  const cleaned = cleanDisplayName(raw);
  if (cleaned.length < NAME_MIN_LENGTH || cleaned.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: `El nombre debe tener entre ${NAME_MIN_LENGTH} y ${NAME_MAX_LENGTH} caracteres.`,
    };
  }

  return { ok: true, value: cleaned };
}

/**
 * Parsea un texto crudo recibido por WebSocket y valida que cumpla el contrato JSON.
 * Se ejecuta en runtime porque los tipos de TypeScript desaparecen al compilar.
 */
export function parseAndValidateClientMessage(
  rawData: string
): ValidationResult<ClientMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return {
      ok: false,
      code: 'INVALID_JSON',
      message: 'El mensaje recibido no es un JSON válido.',
    };
  }

  // En JS, typeof null y typeof [] también dan 'object'; los descartamos explícitamente.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'El mensaje debe ser un objeto JSON.',
    };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== 'string' || record.type.trim() === '') {
    return {
      ok: false,
      code: 'INVALID_PAYLOAD',
      message: 'El mensaje debe incluir un campo "type" de tipo texto.',
    };
  }

  switch (record.type) {
    case 'join': {
      const nameCheck = validateParticipantName(record.name);
      if (!nameCheck.ok) {
        return nameCheck;
      }
      return {
        ok: true,
        value: { type: 'join', name: nameCheck.value },
      };
    }

    default: {
      return {
        ok: false,
        code: 'UNKNOWN_TYPE',
        message: `Tipo de mensaje desconocido: "${record.type}".`,
      };
    }
  }
}
