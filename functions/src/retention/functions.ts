import { scheduledJobFunction } from "../p2/scheduled"
import { RETENTION_APPLY_SPEC } from "./apply"

/**
 * Audit F42: the deployed retention functions. `retentionApplyTick` enqueues `retention.apply` for every firm once per
 * PKT day at 01:00 (spec R11); `retentionDeletionWatch` (./watch.ts) alerts on overdue deletion acknowledgements every
 * 15 minutes (spec R10). Neither is a tenant entry point: they take no caller and act on each firm's own rows.
 */
export const retentionApplyTick = scheduledJobFunction(RETENTION_APPLY_SPEC)
export { retentionDeletionWatch } from "./watch"
