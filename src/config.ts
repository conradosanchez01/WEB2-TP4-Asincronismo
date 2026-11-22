import 'dotenv/config';

export interface AppConfig {
  port: number;
  catalogBaseUrl: string;
  catalogTimeoutMs: number;
  catalogDelayMs: number;
}

function parseIntegerEnv(
  name: string,
  defaultValue: number,
  options: { min: number; max?: number }
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < options.min ||
    (options.max !== undefined && parsed > options.max)
  ) {
    throw new Error(
      `Variable de entorno inválida ${name}="${raw}". Debe ser un entero >= ${options.min}` +
        (options.max !== undefined ? ` y <= ${options.max}` : '') +
        '.'
    );
  }

  return parsed;
}

function parseUrlEnv(name: string, defaultValue: string): string {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? defaultValue : raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Variable de entorno inválida ${name}="${value}". Debe ser una URL válida.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Variable de entorno inválida ${name}="${value}". Debe usar protocolo http o https.`
    );
  }

  return value.replace(/\/+$/, '');
}

export function loadConfig(): AppConfig {
  const port = parseIntegerEnv('PORT', 3000, { min: 1, max: 65535 });
  const catalogBaseUrl = parseUrlEnv('CATALOG_BASE_URL', 'https://dummyjson.com/products');
  const catalogTimeoutMs = parseIntegerEnv('CATALOG_TIMEOUT_MS', 3000, { min: 100 });
  const catalogDelayMs = parseIntegerEnv('CATALOG_DELAY_MS', 0, { min: 0 });

  if (catalogDelayMs > 5000 && catalogBaseUrl.includes('dummyjson.com')) {
    console.warn(
      `[config] Advertencia: CATALOG_DELAY_MS=${catalogDelayMs} supera el máximo de 5000 ms aceptado por DummyJSON (devolverá HTTP 400).`
    );
  }

  return {
    port,
    catalogBaseUrl,
    catalogTimeoutMs,
    catalogDelayMs,
  };
}
