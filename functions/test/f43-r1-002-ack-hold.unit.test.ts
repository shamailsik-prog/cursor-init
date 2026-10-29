import { Timestamp } from "firebase-admin/firestore"
import { describe, expect, it } from "vitest"
import { ACK_HOLD_MS, ACK_WINDOW_MS, pageIdFor, type AlertRow } from "../src/alerts/model"
import { stageAlert } from "../src/alerts/raise"

/**
 * FA-F43-R1-002: an acknowledged alert suppresses paging only until `ACK_HOLD_MS` lapses; the next raise reopens a new
 * episode at level 0 with acknowledgment cleared and a fresh level-0 page. These unit tests pin `stageAlert` directly so
 * mutants that drop `ackHoldExpired`, infinite hold, or stale ack fields fail without the escalation e2e harness.
 */

type Write = { kind: "set" | "update"; path: string; data: Record<string, unknown> }

function recordingTx(alertPath = "ops_alerts/a_test") {
  const writes: Write[] = []
  const ref = { path: alertPath }
  const tx = {
    set: (r: { path: string }, data: Record<string, unknown>) => writes.push({ kind: "set", path: r.path, data }),
    update: (r: { path: string }, data: Record<string, unknown>) => writes.push({ kind: "update", path: r.path, data }),
  }
  return { tx: tx as never, writes, ref: ref as never }
}

const baseSpec = {
  condition: "ai.kill_switch_blocked" as const,
  firmId: "firm-a",
  subjectKey: "firm:firm-a",
  ref: null,
  severity: "warning" as const,
  detail: { reason: "kill_switch_firm" },
}

function acknowledgedRow(ackAtMs: number, episode = 1): AlertRow {
  const ackAt = Timestamp.fromMillis(ackAtMs)
  return {
    schemaVersion: 1,
    condition: "ai.kill_switch_blocked",
    firmId: "firm-a",
    subjectKey: "firm:firm-a",
    ref: null,
    detail: { reason: "kill_switch_firm" },
    baseSeverity: "warning",
    severity: "warning",
    state: "acknowledged",
    level: 0,
    ownerRole: "operator",
    episode,
    count: 6,
    totalCount: 6,
    firstSeenAt: Timestamp.fromMillis(ackAtMs - 60_000),
    lastSeenAt: Timestamp.fromMillis(ackAtMs - 30_000),
    escalateAt: null,
    escalations: [],
    actions: [{ action: "acknowledge", by: "op1", role: "operator", level: 0, at: ackAt }],
    acknowledgedAt: ackAt,
    acknowledgedBy: { uid: "op1", role: "operator" },
    resolvedAt: null,
    resolvedBy: null,
    createdAt: Timestamp.fromMillis(ackAtMs - 120_000),
    updatedAt: ackAt,
  }
}

/** Partner-style acknowledgment after escalation (level ≥ 1); FA-F43-R1-002-001 pins level reset on hold-expired reopen. */
function acknowledgedEscalatedRow(ackAtMs: number, level = 1, episode = 1): AlertRow {
  const ackAt = Timestamp.fromMillis(ackAtMs)
  const escalatedAt = Timestamp.fromMillis(ackAtMs - 15 * 60_000)
  return {
    schemaVersion: 1,
    condition: "ai.kill_switch_blocked",
    firmId: "firm-a",
    subjectKey: "firm:firm-a",
    ref: null,
    detail: { reason: "kill_switch_firm" },
    baseSeverity: "warning",
    severity: "warning",
    state: "acknowledged",
    level,
    ownerRole: "partner",
    episode,
    count: 4,
    totalCount: 4,
    firstSeenAt: Timestamp.fromMillis(ackAtMs - 60 * 60_000),
    lastSeenAt: Timestamp.fromMillis(ackAtMs - 30_000),
    escalateAt: null,
    escalations: [{ level, ownerRole: "partner", severity: "warning", at: escalatedAt }],
    actions: [
      { action: "escalate", by: "system", role: "operator", level, at: escalatedAt },
      { action: "acknowledge", by: "p1", role: "partner", level, at: ackAt },
    ],
    acknowledgedAt: ackAt,
    acknowledgedBy: { uid: "p1", role: "partner" },
    resolvedAt: null,
    resolvedBy: null,
    createdAt: Timestamp.fromMillis(ackAtMs - 120 * 60_000),
    updatedAt: ackAt,
  }
}

describe("FA-F43-R1-002: acknowledgment hold and reopen", () => {
  it("ACK_HOLD_MS matches the warning acknowledgment window and is not an infinite hold", () => {
    expect(ACK_HOLD_MS).toBe(ACK_WINDOW_MS.warning)
    expect(ACK_HOLD_MS).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(ACK_HOLD_MS).toBe(4 * 3_600_000)
  })

  it("within ACK_HOLD_MS a recurrence only counts (no reopen, no level-0 page)", () => {
    const ackAt = 1_700_000_000_000
    const nowMs = ackAt + ACK_HOLD_MS - 1
    const { tx, writes, ref } = recordingTx()
    const staged = stageAlert(tx, { spec: baseSpec, id: "a_test", ref, current: acknowledgedRow(ackAt) }, nowMs)
    expect(staged).toBe("counted")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ kind: "update", path: "ops_alerts/a_test" })
    expect(writes[0]?.data.count).toBe(7)
  })

  it("after ACK_HOLD_MS a recurrence reopens episode at level 0, clears ack fields, and stages a level-0 page", () => {
    const ackAt = 1_700_000_000_000
    const nowMs = ackAt + ACK_HOLD_MS
    const { tx, writes, ref } = recordingTx()
    const staged = stageAlert(tx, { spec: baseSpec, id: "a_test", ref, current: acknowledgedRow(ackAt, 1) }, nowMs)
    expect(staged).toBe("reopened")
    const alertWrite = writes.find((w) => w.path === "ops_alerts/a_test" && w.kind === "set")
    expect(alertWrite?.data).toMatchObject({
      state: "open",
      level: 0,
      ownerRole: "operator",
      episode: 2,
      count: 1,
      totalCount: 7,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
    })
    const pageId = pageIdFor("a_test", 2, 0)
    expect(writes.some((w) => w.path === `ops_alert_notifications/${pageId}` && w.kind === "set")).toBe(true)
  })

  it("FA-F43-R1-002-001: after ACK_HOLD_MS reopen resets to level 0 when the prior acknowledgment was at level ≥1", () => {
    const ackAt = 1_700_000_000_000
    const nowMs = ackAt + ACK_HOLD_MS
    const { tx, writes, ref } = recordingTx()
    const staged = stageAlert(
      tx,
      { spec: baseSpec, id: "a_test", ref, current: acknowledgedEscalatedRow(ackAt, 1, 1) },
      nowMs
    )
    expect(staged).toBe("reopened")
    const alertWrite = writes.find((w) => w.path === "ops_alerts/a_test" && w.kind === "set")
    expect(alertWrite?.data).toMatchObject({
      state: "open",
      level: 0,
      ownerRole: "operator",
      episode: 2,
      count: 1,
      totalCount: 5,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
    })
    const pageId = pageIdFor("a_test", 2, 0)
    expect(writes.some((w) => w.path === `ops_alert_notifications/${pageId}` && w.kind === "set")).toBe(true)
  })
})
