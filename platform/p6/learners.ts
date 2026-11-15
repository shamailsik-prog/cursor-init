/**
 * Learning components stay off until Gate G-3 has passed and the firm flag is on
 * (Layer 17 L17.14 item 77; Layer 18 §10). The seed default is false
 * (postgres/ddl/002_platform.sql, LEARNERS_ENABLED). This module does not start a learner.
 */

export type LearnerPosture = {
  /** A recorded G-3 pass. A green local proof is not a pass. */
  g3Passed: boolean
  /** LEARNERS_ENABLED. Seeded false and left false by this change. */
  learnersFlag: boolean
}

/** True only when both gates are open. Either one closed keeps learners stopped. */
export function learnersMayRun(state: LearnerPosture): boolean {
  return state.g3Passed === true && state.learnersFlag === true
}

/** Refuses to start a learner while G-3 has not passed or the flag is off. */
export function assertLearnersStopped(state: LearnerPosture): void {
  if (!learnersMayRun(state)) {
    throw new Error("learners remain off until G3 passes")
  }
}
