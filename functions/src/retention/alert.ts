import type { AlertSpec } from "../alerts/model"
import { detailInt, detailText } from "../alerts/raise"
import { safeRef } from "../alerts/specs"

/**
 * Audit F42 (spec R10): the unacknowledged-deletion alert, raised through audit F43's durable alerts (`ops_alerts`,
 * acknowledged and escalated operator, then partner, then firm admin, each level paged once). F43 landed on main before
 * this branch merged, so the narrow log-line seam the F42 brief allowed is retired: the watch prepares and stages this
 * alert in the same transaction that stamps the request's `alertedAt`, so the alert commits if and only if the stamp
 * does.
 *
 * The subject is the deletion request, never the matter, and the detail is counts only, so the alert record holds no
 * matter id and stays out of matter-deletion scope (F43's guard refuses anything but codes, ids and integers).
 */
export function deletionUnacknowledgedSpec(firmId: string, requestId: string, expected: number, acked: number): AlertSpec {
  return {
    condition: "retention.deletion_unacknowledged",
    firmId,
    subjectKey: `deletionRequest:${detailText(requestId)}`,
    ref: safeRef("deletion_requests", requestId),
    severity: "high",
    detail: { expected: detailInt(expected), acked: detailInt(acked), missing: detailInt(Math.max(0, expected - acked)) },
  }
}
