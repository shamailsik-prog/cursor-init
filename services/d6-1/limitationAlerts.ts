import type { SpineStore } from "@/platform/spine/store"
import { limitationAlertSchedule } from "@/services/d4-2/limitationDates"

declare module "@/platform/spine/store" {
  interface FollowUp {
    dueOn?: string
    daysBefore?: 90 | 30 | 7
    deadline?: string
    delivery?: "none"
  }
}

/**
 * D6-1 diary rows for a limitation deadline. The court-ops follow-up queue lists them.
 * Nothing is sent: delivery stays "none".
 */
export function scheduleLimitationAlerts(
  store: SpineStore,
  input: { firmId: string; matterId: string; courtId: string; deadline: string; article: string }
): void {
  for (const row of store.followUps) {
    if (
      row.matterId === input.matterId &&
      row.kind === "limitation_alert" &&
      row.status !== "resolved" &&
      row.deadline !== input.deadline
    ) {
      row.status = "resolved"
      row.resolvedBy = "limitation-engine"
      row.resolvedAt = Date.now()
    }
  }
  for (const alert of limitationAlertSchedule(input.deadline)) {
    const id = `limalert_${input.matterId}_${input.deadline}_d${alert.daysBefore}`
    if (store.followUps.some((row) => row.id === id)) continue
    store.followUps.push({
      id,
      firmId: input.firmId,
      matterId: input.matterId,
      courtId: input.courtId,
      raw: `limitation diary ${alert.daysBefore} days before ${input.deadline} for article ${input.article}, due ${alert.dueOn}, not delivered`,
      kind: "limitation_alert",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      dueOn: alert.dueOn,
      daysBefore: alert.daysBefore,
      deadline: input.deadline,
      delivery: "none",
    })
  }
}
