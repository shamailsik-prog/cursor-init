/**
 * The byte-level contract every document vault backend meets. Backends see only the encrypted
 * envelope (documentObjectStore.ts encrypts before calling them) and only keys built by
 * documentObjectStore.ts from validated, firm-scoped identities.
 */
export type DocumentObjectBackendKind = "memory" | "fs" | "r2"
export type DocumentObjectScheme = "fs://" | "r2://"

export interface DocumentObjectBackend {
  readonly kind: DocumentObjectBackendKind
  /** Scheme of the storagePath values this backend serves (`fs://` for memory and fs). */
  readonly scheme: DocumentObjectScheme
  /** Creates the object; throws DocumentObjectExistsError if the key already exists. */
  putIfAbsent(key: string, payload: Buffer): Promise<void>
  /** Reads the stored bytes from the backing store itself, never from a local cache. */
  get(key: string): Promise<Buffer>
  /** Removes the object; removing an absent object is not an error. */
  delete(key: string): Promise<void>
}

/** The vault is misconfigured; uploads and reads fail closed (HTTP 503 on ingest). */
export class DocumentObjectConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentObjectConfigurationError"
  }
}

/** Objects are immutable: a second write to a key is refused, never applied. */
export class DocumentObjectExistsError extends Error {
  constructor(key: string) {
    super(`document object already exists (immutable): ${key}`)
    this.name = "DocumentObjectExistsError"
  }
}

export class DocumentObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`document object not found: ${key}`)
    this.name = "DocumentObjectNotFoundError"
  }
}
