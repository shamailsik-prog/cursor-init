/**
 * D2-1 outbound transport. This slice has a stub only: it records the reply and
 * does not open a socket, look up a number, or call a provider.
 */

export type OutboundWhatsApp = {
  toUserId: string
  text: string
}

export type WhatsAppSendResult = {
  delivered: false
  transport: "stub"
}

export type WhatsAppSendOptions = {
  /** Aborted when the webhook gives up on this attempt. A late completion must not record. */
  signal?: AbortSignal
  /** Same inbound payload shares one outbound record, including the retry after a timeout. */
  idempotencyKey?: string
  /** Logical clock for the idempotency window. Defaults to Date.now(). */
  now?: number
  /** How long a recorded key suppresses another send. Omitted means the key does not expire. */
  idempotencyTtlMs?: number
  /** Fires once the provider has accepted this send, even if the promise is still pending. */
  onAccepted?: () => void
}

export interface WhatsAppTransport {
  send(message: OutboundWhatsApp, options?: WhatsAppSendOptions): Promise<WhatsAppSendResult>
}

export type StubSent = OutboundWhatsApp & WhatsAppSendResult

export class StubWhatsAppTransport implements WhatsAppTransport {
  readonly sent: StubSent[] = []
  private readonly deliveredKeys = new Map<string, number>()

  async send(message: OutboundWhatsApp, options?: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    if (options?.signal?.aborted) {
      const reason = options.signal.reason
      throw reason instanceof Error ? reason : Object.assign(new Error("whatsapp_send_aborted"), { name: "AbortError" })
    }
    const now = options?.now ?? Date.now()
    const key = options?.idempotencyKey
    if (key !== undefined && this.keyLive(key, now, options?.idempotencyTtlMs)) {
      options?.onAccepted?.()
      return { delivered: false, transport: "stub" }
    }
    const result: WhatsAppSendResult = { delivered: false, transport: "stub" }
    if (key !== undefined) this.deliveredKeys.set(key, now)
    this.sent.push({ ...message, ...result })
    options?.onAccepted?.()
    return result
  }

  reset(): void {
    this.sent.length = 0
    this.deliveredKeys.clear()
  }

  private keyLive(key: string, now: number, ttlMs: number | undefined): boolean {
    const at = this.deliveredKeys.get(key)
    if (at === undefined) return false
    if (ttlMs === undefined) return true
    return now < at + ttlMs
  }
}

/** The process stub the route uses. Tests reset it; nothing sends it. */
export const webhookStub = new StubWhatsAppTransport()
