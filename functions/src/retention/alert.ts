import { logger } from "firebase-functions"

/**
 * Audit F42 (spec R10): the one seam through which the retention code raises an operator alert. Today it writes the
 * ERROR log line that `infra/deploy-manifest.json` registers as a log-based alert policy (fields: ids and counts only).
 * Follow-up FU-3: when audit F43's durable alerts land on main, route this through its `prepareAlert` / `stageAlert`
 * (condition `retention.deletion_unacknowledged`) so the alert has an acknowledgement and an escalation chain.
 */

export type RetentionAlertEvent = "retention.deletion_unacknowledged"
export type RetentionAlertFields = Record<string, string | number>

/** Test-only capture of raised alerts (the log line is still written). */
export const retentionAlertTestSeam: { sink?: (event: RetentionAlertEvent, fields: RetentionAlertFields) => void } = {}

export function raiseRetentionAlert(event: RetentionAlertEvent, fields: RetentionAlertFields): void {
  if (process.env.NODE_ENV !== "production") retentionAlertTestSeam.sink?.(event, fields)
  switch (event) {
    case "retention.deletion_unacknowledged":
      logger.error("retention.deletion_unacknowledged", fields)
      return
  }
}
