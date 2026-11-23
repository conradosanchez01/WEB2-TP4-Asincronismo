import { ProductItem, ServerErrorCode } from '../types/protocol.js';
import { normalizeName } from '../validation/messageValidator.js';
import { CatalogProduct } from './catalogService.js';

/** Estructura interna de un producto almacenado en la memoria del servidor. */
interface StoredProduct {
  id: number;
  title: string;
  price: number;
  image: string;
  proposedBy: string;
  addedAt: number;
  /** Contador incremental para garantizar un orden estable incluso si dos productos llegan en el mismo milisegundo. */
  sequence: number;
}

/** Resultado de una operación sobre el estado en memoria. */
export type StoreActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: ServerErrorCode; message: string };

/**
 * Almacén en memoria de la aplicación (sin base de datos).
 * Administra los participantes conectados y la lista de productos propuestos.
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
      addedAt: Date.now(),
      sequence: ++this.sequenceCounter,
    };

    this.products.set(stored.id, stored);
    return { ok: true, product: this.toProductItem(stored) };
  }

  /** Devuelve los productos de la lista ordenados por orden de incorporación. */
  getProducts(): ProductItem[] {
    return Array.from(this.products.values())
      .sort((a, b) => a.sequence - b.sequence)
      .map((stored) => this.toProductItem(stored));
  }

  /** Proyecta un StoredProduct interno al formato público definido en el contrato. */
  private toProductItem(stored: StoredProduct): ProductItem {
    return {
      id: stored.id,
      title: stored.title,
      price: stored.price,
      image: stored.image,
      proposedBy: stored.proposedBy,
      addedAt: stored.addedAt,
    };
  }
}
