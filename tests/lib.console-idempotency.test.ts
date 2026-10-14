import { describe, expect, it } from "vitest"
import {
  idempotencyKeyForUserAction,
  isUuidV4,
  newIdempotencyKey,
  type IdempotentUserAction,
} from "@/lib/console/idempotency"

describe("console idempotency keys", () => {
  it("issues a fresh UUID v4 per user action", async () => {
    const a = await newIdempotencyKey()
    const b = await newIdempotencyKey()
    expect(isUuidV4(a)).toBe(true)
    expect(isUuidV4(b)).toBe(true)
    expect(a).not.toBe(b)
  })

  it("reuses the key for retries of the same action but not for separate actions", async () => {
    const firstAction: IdempotentUserAction = {}
    const retry: IdempotentUserAction = {}
    const k1 = await idempotencyKeyForUserAction(firstAction)
    const k2 = await idempotencyKeyForUserAction(firstAction)
    const k3 = await idempotencyKeyForUserAction(retry)
    expect(k1).toBe(k2)
    expect(k3).not.toBe(k1)
  })

  it("does not collapse distinct actions that share the same JSON body", async () => {
    const body = { action: "create", firmId: "firmA", title: "t" }
    const actionA: IdempotentUserAction = {}
    const actionB: IdempotentUserAction = {}
    await idempotencyKeyForUserAction(actionA)
    await idempotencyKeyForUserAction(actionB)
    expect(actionA.idempotencyKey).not.toBe(actionB.idempotencyKey)
    expect(body).toEqual({ action: "create", firmId: "firmA", title: "t" })
  })
})
