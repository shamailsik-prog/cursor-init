/** Layer 18 §4.2 — every POST/PUT requires Idempotency-Key (UUID v4). */

export class IdempotencyError extends Error {
  status = 400
  constructor(message = "Idempotency-Key header required") {
    super(message)
    this.name = "IdempotencyError"
  }
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key")
  if (!key) {
    throw new IdempotencyError()
  }
  return key
}
