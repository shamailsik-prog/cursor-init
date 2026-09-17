/** Layer 18 §4.2 — every POST/PUT requires Idempotency-Key (UUID v4). */

export class IdempotencyError extends Error {
  status = 400
  constructor(message = "Idempotency-Key header required") {
    super(message)
    this.name = "IdempotencyError"
  }
}

export class IdempotencyConflictError extends Error {
  status = 409
  constructor(message = "Idempotency-Key reused with a different request payload") {
    super(message)
    this.name = "IdempotencyConflictError"
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

/** Process-local replay cache. Bounded. Not a durable store. */
export class IdempotencyCache<T> {
  private readonly entries = new Map<
    string,
    { at: number; body: T; requestFingerprint?: string }
  >()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get size(): number {
    return this.entries.size
  }

  get(key: string): T | undefined {
    this.prune()
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return hit.body
  }

  getReplay(
    key: string,
    requestFingerprint: string
  ): { body?: T; conflict: boolean } {
    this.prune()
    const hit = this.entries.get(key)
    if (!hit) return { conflict: false }
    if (Date.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key)
      return { conflict: false }
    }
    if (
      hit.requestFingerprint &&
      hit.requestFingerprint !== requestFingerprint
    ) {
      return { conflict: true }
    }
    return { body: hit.body, conflict: false }
  }

  set(key: string, body: T, requestFingerprint?: string): void {
    this.prune()
    this.entries.set(key, { at: Date.now(), body, requestFingerprint })
    this.evictOldest()
  }

  prune(): void {
    const now = Date.now()
    for (const [key, row] of this.entries) {
      if (now - row.at >= this.ttlMs) this.entries.delete(key)
    }
  }

  private evictOldest(): void {
    if (this.entries.size <= this.maxEntries) return
    const ordered = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)
    const drop = this.entries.size - this.maxEntries
    for (let i = 0; i < drop; i++) {
      const key = ordered[i]?.[0]
      if (key) this.entries.delete(key)
    }
  }
}
