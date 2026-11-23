import {
  ProductItem,
  ScreenProductItem,
  ServerErrorCode,
} from '../types/protocol.js';
import { normalizeName } from '../validation/messageValidator.js';
import { CatalogProduct } from './catalogService.js';

/** Estructura interna de un producto almacenado en la memoria del servidor. */
interface StoredProduct {
  id: number;
  title: string;
  price: number;
  image: string;
  proposedBy: string;
  /** Nombre normalizado del autor para verificar permisos de eliminación sin distinguir mayúsculas. */
  proposedByNormalized: string;
  /** Mapa de votantes: nombre normalizado -> nombre visible (garantiza máximo 1 voto por persona). */
  voters: Map<string, string>;
  addedAt: number;
  /** Contador incremental para desempatar de forma estable productos con igual cantidad de votos. */
  sequence: number;
}

/** Resultado de una operación sobre el estado en memoria. */
export type StoreActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

/**
 * Almacén en memoria de la aplicación (sin base de datos).
 * Administra los participantes conectados, los productos propuestos, sus votos y el ranking.
 */
export class GiftListStore {
  // Mapa: nombre normalizado (minúsculas) -> nombre visible elegido por el usuario.
  private readonly participants = new Map<string, string>();
  // Mapa: id del producto en DummyJSON -> datos almacenados en memoria.
  private readonly products = new Map<number, StoredProduct>();
  private sequenceCounter = 0;

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

  /** Indica si un producto ya existe en la lista compartida. */
  hasProduct(productId: number): boolean {
    return this.products.has(productId);
  }

  /**
   * Inserción atómica en memoria: como esta función es 100% síncrona (sin await),
   * Node.js la ejecuta sin interrupciones en el Event Loop. Si dos participantes
   * proponen el mismo producto a la vez, la primera consulta que termine lo inserta
   * y la segunda detecta inmediatamente ALREADY_EXISTS sin generar duplicados.
   */
  addProduct(
    catalogProduct: CatalogProduct,
    proposedBy: string
  ): { ok: true; product: ProductItem } | { ok: false; reason: 'ALREADY_EXISTS' } {
    if (this.products.has(catalogProduct.id)) {
      return { ok: false, reason: 'ALREADY_EXISTS' };
    }

    const stored: StoredProduct = {
      id: catalogProduct.id,
      title: catalogProduct.title,
      price: catalogProduct.price,
      image: catalogProduct.image,
      proposedBy,
      proposedByNormalized: normalizeName(proposedBy),
      voters: new Map<string, string>(),
      addedAt: Date.now(),
      sequence: ++this.sequenceCounter,
    };

    this.products.set(stored.id, stored);
    return { ok: true, product: this.toProductItem(stored) };
  }

  /**
   * Registra el voto de un participante sobre un producto existente.
   * Al guardarse por clave de votante en un Map (y ejecutarse síncronamente),
   * dos votos simultáneos de personas distintas siempre se contabilizan ambos,
   * mientras que el mismo usuario nunca puede votar dos veces el mismo producto.
   */
  vote(productId: number, voterDisplayName: string): StoreActionResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: `No existe el producto #${productId} en la lista.`,
      };
    }

    const voterKey = normalizeName(voterDisplayName);
    if (product.voters.has(voterKey)) {
      return {
        ok: false,
        code: 'ALREADY_VOTED',
        message: `Ya votaste el producto "${product.title}".`,
      };
    }

    product.voters.set(voterKey, voterDisplayName);
    return { ok: true, value: undefined };
  }

  /** Retira el voto previamente emitido por un participante sobre un producto. */
  unvote(productId: number, voterDisplayName: string): StoreActionResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: `No existe el producto #${productId} en la lista.`,
      };
    }

    const voterKey = normalizeName(voterDisplayName);
    if (!product.voters.has(voterKey)) {
      return {
        ok: false,
        code: 'NOT_VOTED',
        message: `Todavía no votaste el producto "${product.title}".`,
      };
    }

    product.voters.delete(voterKey);
    return { ok: true, value: undefined };
  }

  /**
   * Quita un producto de la lista aplicando la regla de autorización en el servidor:
   * únicamente quien propuso el producto puede eliminarlo.
   */
  removeProduct(productId: number, requesterDisplayName: string): StoreActionResult {
    const product = this.products.get(productId);
    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: `No existe el producto #${productId} en la lista.`,
      };
    }

    if (product.proposedByNormalized !== normalizeName(requesterDisplayName)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `Solo "${product.proposedBy}" (quien propuso el producto) puede quitarlo de la lista.`,
      };
    }

    this.products.delete(productId);
    return { ok: true, value: undefined };
  }

  /**
   * Devuelve todos los productos ordenados por ranking:
   * 1) Mayor cantidad de votos primero (DESC).
   * 2) En caso de empate, el que se agregó antes queda arriba (sequence ASC).
   */
  getRankedProducts(): ProductItem[] {
    return Array.from(this.products.values())
      .sort((a, b) => {
        if (b.voters.size !== a.voters.size) {
          return b.voters.size - a.voters.size;
        }
        return a.sequence - b.sequence;
      })
      .map((stored) => this.toProductItem(stored));
  }

  /** Devuelve la vista resumida del ranking pensada para la pantalla compartida (SSE). */
  getScreenProducts(): ScreenProductItem[] {
    return this.getRankedProducts().map((item) => ({
      id: item.id,
      title: item.title,
      price: item.price,
      image: item.image,
      proposedBy: item.proposedBy,
      votesCount: item.votesCount,
    }));
  }

  /** Proyecta un StoredProduct interno al formato público definido en el contrato. */
  private toProductItem(stored: StoredProduct): ProductItem {
    return {
      id: stored.id,
      title: stored.title,
      price: stored.price,
      image: stored.image,
      proposedBy: stored.proposedBy,
      votesCount: stored.voters.size,
      voters: Array.from(stored.voters.values()),
      addedAt: stored.addedAt,
    };
  }
}
