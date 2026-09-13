/** Layer 18 §4.2 — every POST/PUT requires Idempotency-Key (UUID v4). */

export class IdempotencyError extends Error {
  status = 400
  constructor(message = "Idempotency-Key header required") {
    super(message)
    this.name = "IdempotencyError"
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key")
  if (!key) {
    throw new IdempotencyError()
  }
  if (!UUID_V4.test(key)) {
    throw new IdempotencyError("Idempotency-Key must be UUID v4")
  }
  return key
}
