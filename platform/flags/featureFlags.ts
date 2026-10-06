/**
 * Feature flags (Layer 18 §9.1 rule 4): every layer sits behind a flag with a
 * per-firm override; disabling a layer leaves its data intact, and the core must
 * boot with every layer disabled.
 *
 * Resolution order for `isFeatureEnabled(flag, firmId?)`:
 *   1. env `SIKANDER_FLAG_<NAME>` = "true" | "false" (deployment / test override);
 *   2. per-firm override (reserved for Postgres `firm_feature_overrides`; read-only
 *      stub until the P6 store exists, so it never answers yet);
 *   3. the registry default.
 *
 * The registry mirrors `feature_flags` in postgres/ddl/002_platform.sql.
 */
import { NextResponse } from "next/server"

export type FeatureFlag = "CORE_ENABLED" | "LEGACY_GOVERNANCE_CHAINS"

export type FeatureFlagEntry = {
  description: string
  /** Who decides whether the flag may be turned on. */
  owner: string
  /** Where the flag is grounded in the architecture set. */
  specRef: string
  defaultEnabled: boolean
}

export const FLAG_REGISTRY: Readonly<Record<FeatureFlag, FeatureFlagEntry>> = {
  CORE_ENABLED: {
    description: "Core spine",
    owner: "Engineering (core, immutable after G-1 for features)",
    specRef: "L18 §9.1 rules 1 and 4; postgres/ddl/002_platform.sql",
    defaultEnabled: true,
  },
  LEGACY_GOVERNANCE_CHAINS: {
    description:
      "Frozen out-of-spec chains: every /api/d2/ops-reporting view and action, and every " +
      "/api/d4/filings view and action except the core package path " +
      "(create_package, decide_package, the package list)",
    owner: "Partner (Erratum Set No. 2; any re-enable or deletion needs a further erratum)",
    specRef: "Erratum E-24 (ERRATUM_SET_2_PROPOSED.md); L18 §9.1 rule 4; Layer 17 exclusion register",
    defaultEnabled: false,
  },
}

/**
 * Per-firm overrides, reserved for Postgres `firm_feature_overrides`
 * (firm_id, flag, enabled, rollout_percent). Read-only and empty until that
 * table is wired; returns `undefined` so the env / default decide.
 */
function firmOverride(flag: FeatureFlag, firmId: string | undefined): boolean | undefined {
  void flag
  void firmId
  return undefined
}

function envOverride(flag: FeatureFlag): boolean | undefined {
  const raw = process.env[`SIKANDER_FLAG_${flag}`]?.trim().toLowerCase()
  if (raw === "true") return true
  if (raw === "false") return false
  // Unset or unrecognised: no override (fail to the registry default).
  return undefined
}

export function isFeatureEnabled(flag: FeatureFlag, firmId?: string): boolean {
  return envOverride(flag) ?? firmOverride(flag, firmId) ?? FLAG_REGISTRY[flag].defaultEnabled
}

/** The response for a call into a disabled layer. Names the flag and nothing else. */
export function featureDisabledResponse(flag: FeatureFlag): Response {
  return NextResponse.json({ error: "feature_disabled", flag }, { status: 404 })
}
