import { gcpProjectIdForDeployProfile } from "./deployManifestProfile"

type Env = Record<string, string | undefined>

/** Manifest profile names and common local buckets that must stay non-prod-like off-bundle. */
const NON_PROD_LIKE_PROFILES = new Set(["local", "dev", "development", "test"])

/**
 * Deploy profiles that must behave like the production bundle for fail-closed gates (OCR stub, test seams, etc.).
 * Includes canonical manifest names, ME audit shorthand (`prod` / `stage`), and the explicit `unknown` bucket.
 */
const PROD_LIKE_DEPLOY_PROFILES = new Set([
  "production",
  "prod",
  "staging",
  "stage",
  "unknown",
])

function deployProfileFromEnv(env: Env): string {
  const fromArg = env.SIKANDER_DEPLOY_PROFILE
  if (fromArg !== undefined) return fromArg.trim().toLowerCase()
  const raw = process.env.SIKANDER_DEPLOY_PROFILE
  return (raw ?? "").trim().toLowerCase()
}

/** Cloud Run / Functions revision (not the emulator). Inlined so OCR and other leaves avoid importing deployConfig side effects. */
function isHostedRuntime(env: Env): boolean {
  if ((env.FUNCTIONS_EMULATOR ?? "").trim() === "true") return false
  if (env.NODE_ENV === "production") return true
  return Boolean((env.K_SERVICE ?? "").trim() || (env.FUNCTION_TARGET ?? "").trim())
}

function nodeEnvIsProduction(env: Env): boolean {
  if (process.env.NODE_ENV === "production") return true
  const fromArg = env.NODE_ENV?.trim().toLowerCase()
  if (fromArg === "production") return true
  if (env.NODE_ENV === undefined) {
    const host = process.env.NODE_ENV?.trim().toLowerCase()
    if (host === "production") return true
  }
  return false
}

/**
 * True when this process should match deployed production bundle policy off-bundle.
 *
 * The literal `process.env.NODE_ENV === "production"` above is constant-folded in `lib/index.js`
 * (`functions/build.mjs`), so the deployed bundle is always prod-like even when the host leaves `NODE_ENV` unset.
 */
export function isProdLikeFunctionsRuntime(env: Env = process.env): boolean {
  if (nodeEnvIsProduction(env)) return true

  const profile = deployProfileFromEnv(env)
  if (PROD_LIKE_DEPLOY_PROFILES.has(profile)) return true
  if (gcpProjectIdForDeployProfile(profile)) return true

  if (profile && !NON_PROD_LIKE_PROFILES.has(profile) && isHostedRuntime(env)) return true

  return false
}
