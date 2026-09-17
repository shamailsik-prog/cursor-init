import snapshot from "@/data/system-status-snapshot.json"
import {
  FIRESTORE_COLLECTIONS,
  G0_GUARDS,
  OPEN_ITEMS,
  getCourts,
  getDocumentTypes,
} from "@/lib/foundation-data"

export type CheckResult = "PASS" | "FAIL" | "SKIP" | "UNKNOWN"

export type CheckTiming = {
  id: string
  name: string
  result: CheckResult
  elapsedMs: number
  measuredAt: string
}

export type ProcessingState = "idle" | "running" | "waiting" | "blocked" | "none"

export type ProcessingItem = {
  name: string
  state: ProcessingState
  detail: string
  elapsedMs: number | null
}

export type BackendState = "not_connected" | "configured"

export type Backend = {
  name: string
  state: BackendState
  note: string
}

export type SystemStatus = {
  generatedAt: string
  refreshElapsedMs: number
  location: {
    product: string
    firm: string
    phase: string
    where: string
    gateG0: CheckResult
    gateG1: CheckResult
    layers316: string
  }
  processingNow: string
  processing: ProcessingItem[]
  timings: CheckTiming[]
  backends: Backend[]
  inventory: {
    courts: number
    documentTypes: number
    firestoreCollections: number
    openItems: number
    g0Guards: number
  }
}

const MEASURED_AT = snapshot.measuredAt

function envConfigured(keys: string[]): boolean {
  return keys.some((key) => Boolean(process.env[key]?.trim()))
}

function backend(
  name: string,
  keys: string[],
  emptyNote: string,
  configuredNote: string
): Backend {
  const configured = envConfigured(keys)
  return {
    name,
    state: configured ? "configured" : "not_connected",
    note: configured ? configuredNote : emptyNote,
  }
}

function lastCheck(id: string): CheckTiming {
  const found = snapshot.checks.find((item) => item.id === id)
  return {
    id,
    name: found?.name ?? id,
    result: (found?.result as CheckResult | undefined) ?? "UNKNOWN",
    elapsedMs: found?.elapsedMs ?? 0,
    measuredAt: MEASURED_AT,
  }
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return `${hours}h ${minutes}m`
}

export function buildSystemStatus(now = new Date()): SystemStatus {
  const started = Date.now()
  const g0 = lastCheck("g0")
  const g1 = lastCheck("g1")
  const unit = lastCheck("unit")

  const live: ProcessingItem[] = [
    {
      name: "Live job queue",
      state: "none",
      detail:
        "No connected job runner. The jobs collection has Firestore rules only.",
      elapsedMs: null,
    },
    {
      name: "Drafting / WhatsApp / Court Ops",
      state: "blocked",
      detail: "Not built in this Phase 0 slice.",
      elapsedMs: null,
    },
    {
      name: "Provider calls (P1)",
      state: "blocked",
      detail: "No live credentials. Transport defaults to blocked.",
      elapsedMs: null,
    },
    {
      name: "Monitor refresh",
      state: "running",
      detail: "Recomputing location, inventory, and last-measured timings.",
      elapsedMs: null,
    },
  ]

  const workspace: ProcessingItem[] = snapshot.workspace.map((item) => ({
    name: item.name,
    state: item.state as ProcessingState,
    detail: `${item.detail} Last measured ${MEASURED_AT}.`,
    elapsedMs: item.elapsedMs,
  }))

  const active = [...live, ...workspace].filter(
    (item) => item.state === "running" || item.state === "waiting"
  )
  const processingNow =
    active.length === 0
      ? "Nothing is in process. Phase 0 is idle."
      : active
          .map((item) => `${item.name} (${item.state})`)
          .join(" · ")

  const status: SystemStatus = {
    generatedAt: now.toISOString(),
    refreshElapsedMs: 0,
    location: {
      product: "SIKANDER AI",
      firm: "NHS Legal, Karachi",
      phase: "Phase 0 foundations",
      where:
        "Foundation console + G-0/G-1 spine in this repository. Layers 3–16 have not started. Firebase, Postgres, and R2 are not connected.",
      gateG0: g0.result,
      gateG1: g1.result,
      layers316: "not started",
    },
    processingNow,
    processing: [...live, ...workspace],
    timings: [g0, g1, unit],
    backends: [
      backend(
        "Firebase / Firestore",
        ["FIREBASE_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
        "Not connected. Rules exist; live project is TODO(firm).",
        "Credentials present in the environment. Live deploy is still a firm decision."
      ),
      backend(
        "Postgres",
        ["DATABASE_URL", "POSTGRES_URL"],
        "Not connected. Annex A DDL is in-repo only.",
        "A database URL is present. Live G-0 checks still need gate_g0_live.sh."
      ),
      backend(
        "R2 object storage",
        ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID"],
        "Not connected. O-2 signer live test is still TODO(firm).",
        "R2 keys are present. Do not invent bucket or residency values."
      ),
    ],
    inventory: {
      courts: getCourts().length,
      documentTypes: getDocumentTypes().length,
      firestoreCollections: FIRESTORE_COLLECTIONS.length,
      openItems: OPEN_ITEMS.length,
      g0Guards: G0_GUARDS.length,
    },
  }

  status.refreshElapsedMs = Date.now() - started
  return status
}
