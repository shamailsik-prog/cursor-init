import { PLATFORM_ALERT_FIRM, type AlertSpec } from "./model"
import { detailInt, detailText } from "./raise"

/**
 * The alert of each condition (audit F43, spec R8), built from the observation's codes, ids and counts only. Every
 * value goes through `detailText` / `detailInt` and every reference through `safeRef`, so a builder never produces a
 * spec the guard refuses: a raise inside a P1 or P2 transaction can never be the reason that transaction fails.
 */

const REF_PART = /^[A-Za-z0-9_.:-]{1,150}$/

/** `collection/id`, or null when either part is not a plain id. */
export function safeRef(collection: string, id: unknown): string | null {
  return typeof id === "string" && REF_PART.test(id) ? `${collection}/${id}` : null
}

/** P2: a job dead-lettered (in the dead-letter transaction). `attempts` is the job's total attempts. */
export function deadLetterSpec(jobId: string, firmId: string, jobType: unknown, code: string, attempts: number): AlertSpec {
  return {
    condition: "job.dead_lettered",
    firmId,
    subjectKey: `job:${detailText(jobId)}`,
    ref: safeRef("jobs", jobId),
    severity: "high",
    detail: { jobType: detailText(jobType), code: detailText(code), attempts: detailInt(attempts) },
  }
}

/** P2: the jobs of one firm and type the sweeper re-dispatched with no claim in sight (spec R8). */
export type StallGroup = { firmId: string; jobType: string; jobs: number; maxRedispatches: number; oldestWaitMs: number; latestJobId: string }

export function dispatchStalledSpec(g: StallGroup): AlertSpec {
  return {
    condition: "job.dispatch_stalled",
    firmId: g.firmId,
    subjectKey: `jobType:${detailText(g.jobType)}`,
    ref: safeRef("jobs", g.latestJobId),
    severity: "high",
    detail: { jobType: detailText(g.jobType), jobs: detailInt(g.jobs), maxRedispatches: detailInt(g.maxRedispatches), oldestWaitMs: detailInt(g.oldestWaitMs) },
  }
}

/** P2: a worker's finish commit failed (raised in a transaction of its own). */
export function commitFailedSpec(jobId: string, firmId: string, jobType: unknown, code: string): AlertSpec {
  return {
    condition: "job.commit_failed",
    firmId,
    subjectKey: `jobType:${detailText(jobType)}`,
    ref: safeRef("jobs", jobId),
    severity: "high",
    detail: { jobType: detailText(jobType), code: detailText(code) },
  }
}

/** Checker: the waiting jobs of one firm and type (due, or past their lease, `JOB_WAIT_ALERT_MS` or more). */
export function queueAgeSpec(firmId: string, jobType: string, waiting: number, oldestAgeMs: number, oldestJobId: string): AlertSpec {
  return {
    condition: "job.queue_age",
    firmId,
    subjectKey: `jobType:${detailText(jobType)}`,
    ref: safeRef("jobs", oldestJobId),
    severity: "high",
    detail: { jobType: detailText(jobType), waiting: detailInt(waiting), oldestAgeMs: detailInt(oldestAgeMs) },
  }
}

/** Checker: one firm's un-merge sagas in progress `SAGA_AGE_ALERT_MS` or more. */
export function sagaAgeSpec(firmId: string, inProgress: number, oldestAgeMs: number, oldestEventId: string): AlertSpec {
  return {
    condition: "saga.age",
    firmId,
    subjectKey: "sagaType:entity.unmerge",
    ref: safeRef("merge_events", oldestEventId),
    severity: "high",
    detail: { inProgress: detailInt(inProgress), oldestAgeMs: detailInt(oldestAgeMs) },
  }
}

/** Checker: one firm's AI spend reservations still held past their lease, or quarantined by the reconciler. */
export function reservationUnresolvedSpec(firmId: string, unresolved: number, quarantined: number, oldestAgeMs: number, oldestId: string): AlertSpec {
  return {
    condition: "ai.reservation_unresolved",
    firmId,
    subjectKey: `firm:${detailText(firmId)}`,
    ref: safeRef("ai_reservations", oldestId),
    severity: "high",
    detail: { unresolved: detailInt(unresolved), quarantined: detailInt(quarantined), oldestAgeMs: detailInt(oldestAgeMs) },
  }
}

/** What a P1 commit observed (the fields of its usage record that alerts read). */
export type P1Observation = { firmId: string; monthKey: string; model: string; blockReason: string | null; usageLogId: string }
export type P1Crossing = { threshold: number; budgetMicroUsd: number; spentMicroUsd: number }

/**
 * P1: the alerts one committed decision raises (in its commit transaction): each budget threshold it crossed (70:
 * warning, 90: high), a call refused by a kill switch, and a call refused because its reservation or its attempt
 * record failed.
 */
export function p1CommitSpecs(o: P1Observation, crossings: readonly P1Crossing[]): AlertSpec[] {
  const specs: AlertSpec[] = crossings.map((c) => ({
    condition: "ai.budget_threshold",
    firmId: o.firmId,
    subjectKey: `budget:${detailText(o.monthKey)}:${detailInt(c.threshold)}`,
    ref: safeRef("ai_budget_alerts", `${o.firmId}_${o.monthKey}_${c.threshold}`),
    severity: c.threshold >= 90 ? "high" : "warning",
    detail: { monthKey: detailText(o.monthKey), threshold: detailInt(c.threshold), budgetMicroUsd: detailInt(c.budgetMicroUsd), spentMicroUsd: detailInt(c.spentMicroUsd) },
  }))
  if (o.blockReason === "kill_switch_firm") {
    specs.push({
      condition: "ai.kill_switch_blocked",
      firmId: o.firmId,
      subjectKey: "killSwitch:firm",
      ref: safeRef("ai_config", o.firmId),
      severity: "warning",
      detail: { scope: "firm", model: detailText(o.model) },
    })
  }
  if (o.blockReason === "kill_switch_platform") {
    // Spec R24 (re-audit FA-F43-R1-006): one alert for the platform's switch, not one per firm, and read-only once it
    // exists, so the blocked calls of every firm do not all write one document in their commit transactions.
    specs.push({
      condition: "ai.kill_switch_blocked",
      firmId: PLATFORM_ALERT_FIRM,
      subjectKey: "killSwitch:platform",
      ref: "platform/p1",
      severity: "warning",
      detail: { scope: "platform", model: detailText(o.model) },
      observeOnly: true,
    })
  }
  if (o.blockReason === "reservation_failed") {
    specs.push({
      condition: "ai.reservation_failed",
      firmId: o.firmId,
      subjectKey: `firm:${detailText(o.firmId)}`,
      ref: safeRef("ai_usage_logs", o.usageLogId),
      severity: "high",
      detail: { model: detailText(o.model) },
    })
  }
  return specs
}
