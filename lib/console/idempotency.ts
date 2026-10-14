const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function bytesToUuidV4(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Fresh idempotency key for one user-initiated mutation (Web Crypto; safe in browser bundles). */
export async function newIdempotencyKey(): Promise<string> {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return bytesToUuidV4(bytes)
}

/** Reuse the same key when retrying the same user action; each new action gets a new key. */
export type IdempotentUserAction = { idempotencyKey?: string }

export async function idempotencyKeyForUserAction(action: IdempotentUserAction): Promise<string> {
  if (!action.idempotencyKey) {
    action.idempotencyKey = await newIdempotencyKey()
  }
  return action.idempotencyKey
}

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value)
}
