import type { SpineStore } from "@/platform/spine/store"

export function notifyAccounts(store: SpineStore, matterId: string, now = Date.now()) {
  const matter = store.matters.get(matterId)
  if (!matter) throw new Error("unknown matter")
  if (matter.status !== "live") return
  store.intimations.push({
    id: store.id("int"),
    firmId: matter.firmId,
    matterId,
    notifiedAt: now,
    confirmedAt: null,
  })
}

export function intimationsFor(store: SpineStore, matterId: string) {
  return store.intimations.filter((i) => i.matterId === matterId)
}

/** L4.10 — accounts silence after confirmation. */
export function escalateSilence(
  store: SpineStore,
  matterId: string,
  now: number,
  windowMs = 24 * 60 * 60 * 1000
) {
  const rows = intimationsFor(store, matterId)
  for (const row of rows) {
    if (row.confirmedAt) continue
    if (now - row.notifiedAt >= windowMs) {
      const matter = store.matters.get(matterId)!
      store.followUps.push({
        id: store.id("fu"),
        firmId: matter.firmId,
        matterId,
        courtId: matter.courtId,
        raw: "accounts-silence-24h",
        kind: "l4_10_silence",
      })
    }
  }
}
