import { logger } from "firebase-functions"
import { onSchedule } from "firebase-functions/v2/scheduler"
import { adminDb } from "../admin"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { RECONCILER_TIMEOUT_SECONDS, reconcileAuditOutbox } from "./auditOutbox"

/**
 * Audit F11: the scheduled audit-outbox reconciler, every minute, like `p1ReservationReconciler` and the P2 `jobSweeper`.
 * It publishes, once, the audit rows of Next requests that died (or whose flush failed) after an effect committed
 * (./auditOutbox.ts). No caller, no tenant input: each entry is published into its own firm's audit log.
 */
export const auditOutboxReconciler = onSchedule(
  {
    ...RUNTIME_DEFAULTS,
    schedule: "every 1 minutes",
    maxInstances: 1,
    timeoutSeconds: RECONCILER_TIMEOUT_SECONDS,
    ingressSettings: INTERNAL_ONLY,
  },
  async () => {
    await reconcileAuditOutbox({ db: adminDb(), log: logger })
  }
)
