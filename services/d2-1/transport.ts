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

export interface WhatsAppTransport {
  send(message: OutboundWhatsApp): Promise<WhatsAppSendResult>
}

export type StubSent = OutboundWhatsApp & WhatsAppSendResult

export class StubWhatsAppTransport implements WhatsAppTransport {
  readonly sent: StubSent[] = []

  async send(message: OutboundWhatsApp): Promise<WhatsAppSendResult> {
    const result: WhatsAppSendResult = { delivered: false, transport: "stub" }
    this.sent.push({ ...message, ...result })
    return result
  }
}

/** The process stub the route uses. Tests reset it; nothing sends it. */
export const webhookStub = new StubWhatsAppTransport()
