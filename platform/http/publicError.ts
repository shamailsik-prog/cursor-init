/**
 * A deliberate rejection whose message is safe to show the client
 * ("unknown actor", "permission denied: not-member"). Only PublicError messages
 * are passed through by `publicErrorMessage`; every other error is logged
 * server-side and replaced by a generic fallback. Kept free of Next.js imports
 * so services/ and platform/ modules can throw it.
 */
export class PublicError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = "PublicError"
    this.code = code
  }
}
