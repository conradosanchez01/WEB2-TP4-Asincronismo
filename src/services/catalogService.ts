import { AppConfig } from '../config.js';
import { ProposalFailure } from '../types/protocol.js';

/** Datos mínimos del catálogo que el servidor toma de DummyJSON (nunca del cliente). */
export interface CatalogProduct {
  id: number;
  title: string;
  price: number;
  image: string;
}

/**
 * Resultado posible al consultar un producto en DummyJSON:
 * - éxito con los datos del producto,
 * - cancelación silenciosa porque el participante cerró su pestaña mientras esperaba,
 * - o fallo clasificado (NOT_FOUND, TIMEOUT o CATALOG_ERROR).
 */
export type CatalogFetchResult =
  | { ok: true; product: CatalogProduct }
  | { ok: false; abortedByDisconnect: true }
  | { ok: false; abortedByDisconnect: false; failure: ProposalFailure };

interface DummyJsonProduct {
  id?: unknown;
  title?: unknown;
  price?: unknown;
  thumbnail?: unknown;
  images?: unknown;
}

/**
 * Extrae una URL de imagen segura (http/https) priorizando thumbnail y usando
 * la primera imagen del arreglo como respaldo.
 */
function extractImageUrl(data: DummyJsonProduct): string {
  if (typeof data.thumbnail === 'string' && /^https?:\/\//i.test(data.thumbnail)) {
    return data.thumbnail;
  }
  if (Array.isArray(data.images)) {
    for (const entry of data.images) {
      if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) {
        return entry;
      }
    }
  }
  return '';
}

/**
 * Cliente HTTP asíncrono para consultar el catálogo externo (DummyJSON).
 * Aplica timeout por consulta, soporta demora simulada (?delay=) por entorno
 * y permite consultar múltiples productos en paralelo sin bloquear el Event Loop.
 */
export class CatalogService {
  constructor(private readonly config: AppConfig) {}

  /** Construye la URL del producto agregando ?delay=ms si se configuró lentitud simulada. */
  private buildProductUrl(productId: number): string {
    const url = new URL(`${this.config.catalogBaseUrl}/${productId}`);
    if (this.config.catalogDelayMs > 0) {
      url.searchParams.set('delay', String(this.config.catalogDelayMs));
    }
    return url.toString();
  }

  /**
   * Consulta un único producto en el catálogo externo con límite máximo de espera.
   * Combina la señal de timeout con la señal de desconexión del socket para cancelar
   * la petición si el cliente cierra la pestaña antes de recibir respuesta.
   */
  async fetchProduct(
    productId: number,
    disconnectSignal?: AbortSignal
  ): Promise<CatalogFetchResult> {
    if (disconnectSignal?.aborted) {
      return { ok: false, abortedByDisconnect: true };
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort();
    }, this.config.catalogTimeoutMs);

    // AbortSignal.any aborta el fetch apenas venza el timeout O se desconecte el cliente.
    const combinedSignal = disconnectSignal
      ? AbortSignal.any([timeoutController.signal, disconnectSignal])
      : timeoutController.signal;

    try {
      const response = await fetch(this.buildProductUrl(productId), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: combinedSignal,
      });

      if (response.status === 404) {
        return {
          ok: false,
          abortedByDisconnect: false,
          failure: {
            productId,
            reason: 'NOT_FOUND',
            message: `El producto #${productId} no existe en el catálogo.`,
          },
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          abortedByDisconnect: false,
          failure: {
            productId,
            reason: 'CATALOG_ERROR',
            message: `El catálogo respondió con error HTTP ${response.status} para el producto #${productId}.`,
          },
        };
      }

      const data = (await response.json()) as DummyJsonProduct;
      if (
        typeof data.id !== 'number' ||
        typeof data.title !== 'string' ||
        typeof data.price !== 'number'
      ) {
        return {
          ok: false,
          abortedByDisconnect: false,
          failure: {
            productId,
            reason: 'CATALOG_ERROR',
            message: `El catálogo devolvió un formato inesperado para el producto #${productId}.`,
          },
        };
      }

      return {
        ok: true,
        product: {
          id: data.id,
          title: data.title,
          price: data.price,
          image: extractImageUrl(data),
        },
      };
    } catch (error) {
      // Si el fetch falló porque el usuario cerró su pestaña, lo distinguimos del timeout.
      if (disconnectSignal?.aborted) {
        return { ok: false, abortedByDisconnect: true };
      }

      if (
        timeoutController.signal.aborted ||
        (error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'TimeoutError'))
      ) {
        return {
          ok: false,
          abortedByDisconnect: false,
          failure: {
            productId,
            reason: 'TIMEOUT',
            message: `El catálogo no respondió a tiempo para el producto #${productId} (límite: ${this.config.catalogTimeoutMs} ms).`,
          },
        };
      }

      return {
        ok: false,
        abortedByDisconnect: false,
        failure: {
          productId,
          reason: 'CATALOG_ERROR',
          message: `No se pudo consultar el catálogo para el producto #${productId}.`,
        },
      };
    } finally {
      // Siempre limpiamos el temporizador para evitar fugas de memoria.
      clearTimeout(timer);
    }
  }

  /**
   * Consulta todos los IDs de una misma propuesta en simultáneo (en paralelo) con Promise.all.
   * Como fetchProduct captura sus propios errores y devuelve un resultado tipado,
   * el fallo de un producto nunca cancela la carga de los demás.
   */
  async fetchProductsInParallel(
    productIds: number[],
    disconnectSignal?: AbortSignal
  ): Promise<Array<{ productId: number; result: CatalogFetchResult }>> {
    return Promise.all(
      productIds.map(async (productId) => ({
        productId,
        result: await this.fetchProduct(productId, disconnectSignal),
      }))
    );
  }
}
