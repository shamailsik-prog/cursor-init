/**
 * Request-scoped view of the authenticated caller.
 *
 * `withSession` runs each handler inside `runWithSession`, so code that looks
 * the caller up by id (`store.users.get(actorId)`, P5 `checkPermission`, …)
 * sees the caller's clearance as min(record, token claim) for the duration of
 * that request only — the stored record is never modified. This is how a
 * restricting clearance claim takes effect in handlers without rewriting them.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { Classification } from "@/platform/p1/types"

export type RequestIdentity = {
  userId: string
  firmId: string
  /** Effective clearance ceiling for this request (already min(record, claim)). */
  clearance: Classification
}

const storage = new AsyncLocalStorage<RequestIdentity>()

export function runWithSession<T>(identity: RequestIdentity | null, fn: () => T): T {
  return identity ? storage.run(identity, fn) : fn()
}

export function currentRequestIdentity(): RequestIdentity | undefined {
  return storage.getStore()
}
