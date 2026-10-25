import { vi } from "vitest"
import * as functionsLog from "../src/log"

/** Captures manifest-registered ERROR lines emitted through `logRegisteredError` (structured `event` field). */
export function spyRegisteredErrors() {
  const calls: Array<{ event: string; fields: Record<string, unknown> }> = []
  const spy = vi.spyOn(functionsLog, "logRegisteredError").mockImplementation((event, fields = {}) => {
    calls.push({ event, fields: { ...(fields as Record<string, unknown>) } })
  })
  return {
    calls,
    fieldsOf: (event: string) => calls.filter((c) => c.event === event).map((c) => c.fields),
    restore: () => spy.mockRestore(),
  }
}
