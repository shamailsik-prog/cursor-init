/**
 * L5.5 / Q12a flag. Default off.
 *
 * The platform FLAG_REGISTRY is a subset of postgres/ddl/002_platform.sql.
 * This slice does not edit that DDL, so the flag lives with the layer and is
 * not registered there. Resolution matches the platform: env
 * SIKANDER_FLAG_L5_5_DOCKET_GENERATOR is "true" or "false"; anything else,
 * including unset, stays off.
 */
export const DOCKET_GENERATOR_FLAG = "L5_5_DOCKET_GENERATOR" as const

export const DOCKET_GENERATOR_FLAG_ENV = `SIKANDER_FLAG_${DOCKET_GENERATOR_FLAG}` as const

export function isDocketGeneratorEnabled(): boolean {
  const raw = process.env[DOCKET_GENERATOR_FLAG_ENV]?.trim().toLowerCase()
  if (raw === "true") return true
  if (raw === "false") return false
  return false
}
