/**
 * Local L4.6 switch. Unset means off. This file does not register a platform flag.
 * The value must be exactly "true" after trim and lower case.
 */
export const P6_LEARNING_FLAG = "P6_LEARNING"

export function isP6LearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[`SIKANDER_FLAG_${P6_LEARNING_FLAG}`]?.trim().toLowerCase() === "true"
}
