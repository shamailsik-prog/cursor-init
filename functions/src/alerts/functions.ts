import { onSchedule } from "firebase-functions/v2/scheduler"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../runtimeOptions"
import { CHECKER_BUDGET_MS, CHECK_RAISE_GRACE_MS, runAlertChecker } from "./checker"
import { ESCALATOR_BUDGET_MS, runAlertEscalator } from "./escalator"

/**
 * The alert schedules (audit F43, spec R10). Both single-instance, internal ingress, the runtime account, with a
 * pinned timeout that leaves 15 s or more after the run's own wall-clock budget. No scheduler retry: the next run is
 * the retry (each pass is idempotent).
 */

const ESCALATOR_TIMEOUT_SECONDS = 45
const CHECKER_TIMEOUT_SECONDS = 60

// The checker's raises may run CHECK_RAISE_GRACE_MS past its scan budget (spec R20); that grace counts against the 10 s.
if (!(ESCALATOR_BUDGET_MS + 10_000 <= ESCALATOR_TIMEOUT_SECONDS * 1000) || !(CHECKER_BUDGET_MS + CHECK_RAISE_GRACE_MS + 10_000 <= CHECKER_TIMEOUT_SECONDS * 1000)) {
  throw new Error("alert schedules: each run's budget must end at least 10 s before its function timeout")
}

/** Every minute: escalate open alerts past their acknowledgment deadline, then deliver pending pages. */
export const alertEscalator = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 1 minutes", maxInstances: 1, timeoutSeconds: ESCALATOR_TIMEOUT_SECONDS, ingressSettings: INTERNAL_ONLY },
  async () => {
    await runAlertEscalator()
  }
)

/** Every five minutes: derive queue age, saga age and unresolved AI spend from the rows and raise their alerts. */
export const alertChecker = onSchedule(
  { ...RUNTIME_DEFAULTS, schedule: "every 5 minutes", maxInstances: 1, timeoutSeconds: CHECKER_TIMEOUT_SECONDS, ingressSettings: INTERNAL_ONLY },
  async () => {
    await runAlertChecker()
  }
)
