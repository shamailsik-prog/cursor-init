/**
 * Local L4.6 switch. Unset means off. This file does not register a platform flag.
 * CLAIM-282-008: the value must be the exact characters `true`.
 * `TRUE`, ` true `, and a blank are off.
 */
export const P6_LEARNING_FLAG = "P6_LEARNING"

export function isP6LearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[`SIKANDER_FLAG_${P6_LEARNING_FLAG}`] === "true"
}
