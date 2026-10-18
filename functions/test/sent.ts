import type { P1Message } from "../src/p1/transport"

/**
 * What a fake P1 transport records (audit F16): the request exactly as the transport received it (`model`, the
 * role-separated `messages`, `maxTokens`), plus `body`, the content of its user message(s), for the tests that check
 * what the user's turn carried. The request has no `body` of its own since F16.
 */
export type Sent = { model: string; messages: P1Message[]; maxTokens: number; body: string }

export function recordSent(r: { model: string; messages: P1Message[]; maxTokens: number }): Sent {
  const messages = r.messages.map((m) => ({ ...m }))
  return {
    model: r.model,
    messages,
    maxTokens: r.maxTokens,
    body: messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n"),
  }
}
