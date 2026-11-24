/**
 * One client channel (v19 L16.3 step 3, L5580–L5582).
 * Reporting (43), WhatsApp self-service (L8.1) and client update are modes.
 * This module does not send. Live delivery stays with the existing routes until W2-WIRE.
 */
import { assertP6ConsolidationEnabled } from "@/platform/p6/consolidationFlag"

export const CLIENT_MODES = ["reporting", "whatsapp", "update"] as const
export type ClientMode = (typeof CLIENT_MODES)[number]

export type ClientPathInput = {
  firmId: string
  matterId: string
}

export type ClientPathResult = {
  owner: "client"
  mode: ClientMode
  channel: "client-channel"
  firmId: string
  matterId: string
  sent: false
}

let calls = 0

export function clientPathCalls(): number {
  return calls
}

export function runClientPath(input: ClientPathInput & { mode: ClientMode }): ClientPathResult {
  assertP6ConsolidationEnabled()
  calls += 1
  return {
    owner: "client",
    mode: input.mode,
    channel: "client-channel",
    firmId: input.firmId,
    matterId: input.matterId,
    sent: false,
  }
}

export function reportToClient(input: ClientPathInput): ClientPathResult {
  return runClientPath({ ...input, mode: "reporting" })
}

export function whatsAppSelfService(input: ClientPathInput): ClientPathResult {
  return runClientPath({ ...input, mode: "whatsapp" })
}

export function pushClientUpdate(input: ClientPathInput): ClientPathResult {
  return runClientPath({ ...input, mode: "update" })
}
