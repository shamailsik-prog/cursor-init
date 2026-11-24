/**
 * Module 5 intake gate. Env-only, same rule as services/d2-1/grammar.ts:
 * an unset value is off. Anything other than a trimmed "true" is off.
 * Not registered in platform/flags (a later integration PR).
 */

export const D1_INTAKE_FLAG = "D1_INTAKE"

export function intakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[`SIKANDER_FLAG_${D1_INTAKE_FLAG}`]?.trim().toLowerCase() === "true"
}
