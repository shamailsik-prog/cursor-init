import { onRequest, type Request } from "firebase-functions/v2/https"
import { logger } from "firebase-functions"
import { getFunctions } from "firebase-admin/functions"
import type { Response } from "express"
import { adminApp, adminDb } from "./admin"

export const REGION = "asia-south1"

/**
 * Pinned timeout for `api`. The idempotency lease
 * (http/idempotency.ts) must outlive it, or a slow but live request could be
 * taken over and run twice; that module asserts this when it loads.
 */
export const FUNCTION_TIMEOUT_SECONDS = 120

/** Bounded timeout for `/readyz` dependency probes (audit F44). */
export const READINESS_TIMEOUT_MS = 2_000

/** Cache window for readiness count snapshots so probes stay bounded (audit F44). */
export const READINESS_COUNTS_TTL_MS = 30_000

const JOB_WORKER_QUEUE = `locations/${REGION}/functions/jobWorker`

export type ReadinessCounts = {
  queuedJobs: number
}

export type HealthProbeDeps = {
  probeFirestore: () => Promise<void>
  probeQueue: () => Promise<void>
  readQueuedCount: () => Promise<number>
  clock: () => number
  timeoutMs: number
  countsTtlMs: number
}

type CachedCountsSnapshot = {
  counts: ReadinessCounts
  updatedAtMs: number
}

let cachedCounts: CachedCountsSnapshot | null = null

export function resetHealthCache(): void {
  cachedCounts = null
}

export function recordHealthCounts(counts: ReadinessCounts, nowMs: number = Date.now()): void {
  cachedCounts = { counts: { queuedJobs: counts.queuedJobs }, updatedAtMs: nowMs }
}

async function defaultProbeFirestore(): Promise<void> {
  await adminDb().collection("_health").doc("readiness").get()
}

async function defaultProbeQueue(): Promise<void> {
  const queue = getFunctions(adminApp()).taskQueue(JOB_WORKER_QUEUE)
  if (typeof queue?.enqueue !== "function") {
    throw new Error("jobWorker task queue unavailable")
  }
}

async function defaultReadQueuedCount(): Promise<number> {
  const snap = await adminDb().collection("jobs").where("status", "==", "queued").limit(100).select().get()
  return snap.size
}

export const healthRuntime: { deps?: Partial<HealthProbeDeps> } = {}

function resolveDeps(overrides?: Partial<HealthProbeDeps>): HealthProbeDeps {
  return {
    probeFirestore: defaultProbeFirestore,
    probeQueue: defaultProbeQueue,
    readQueuedCount: defaultReadQueuedCount,
    clock: Date.now,
    timeoutMs: READINESS_TIMEOUT_MS,
    countsTtlMs: READINESS_COUNTS_TTL_MS,
    ...healthRuntime.deps,
    ...overrides,
  }
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function normalizePath(req: Partial<Request> | undefined): string {
  const raw =
    typeof req?.path === "string" && req.path !== ""
      ? req.path
      : typeof req?.url === "string" && req.url !== ""
        ? req.url
        : "/"
  const qIndex = raw.indexOf("?")
  const pathname = (qIndex >= 0 ? raw.slice(0, qIndex) : raw).replace(/\/+$/, "")
  return pathname === "" ? "/" : pathname
}

function isLivenessRequest(req: Partial<Request> | undefined): boolean {
  const path = normalizePath(req)
  if (path === "/livez" || path.endsWith("/livez")) return true
  const query = req?.query as Record<string, unknown> | undefined
  return query?.probe === "live"
}

/**
 * Cheap liveness probe (`/livez`, audit F44): no disk, Firestore, or queue I/O.
 */
export function livezHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok", region: REGION })
}

/**
 * Bounded readiness probe (`/readyz` and `/health`, audit F44): probes Firestore and
 * the P2 job queue under a short timeout, uses cached counts with freshness metadata,
 * and returns HTTP 503 when any dependency probe fails or times out.
 */
export async function readyzHandler(
  _req: Request,
  res: Response,
  overrides?: Partial<HealthProbeDeps>
): Promise<void> {
  const deps = resolveDeps(overrides)
  const now = deps.clock()

  const [firestoreResult, queueResult] = await Promise.allSettled([
    withTimeout(deps.probeFirestore, deps.timeoutMs, "firestore probe"),
    withTimeout(deps.probeQueue, deps.timeoutMs, "queue probe"),
  ])

  const firestoreOk = firestoreResult.status === "fulfilled"
  const queueOk = queueResult.status === "fulfilled"

  if (!firestoreOk) {
    logger.warn("readyz: firestore probe failed")
  }
  if (!queueOk) {
    logger.warn("readyz: queue probe failed")
  }

  if (firestoreOk && (cachedCounts === null || now - cachedCounts.updatedAtMs > deps.countsTtlMs)) {
    try {
      const queuedJobs = await withTimeout(deps.readQueuedCount, deps.timeoutMs, "queued count")
      cachedCounts = { counts: { queuedJobs }, updatedAtMs: now }
    } catch {
      logger.warn("readyz: count refresh failed")
    }
  }

  const countsSnapshot = cachedCounts
  const countsAgeMs = countsSnapshot !== null ? Math.max(0, now - countsSnapshot.updatedAtMs) : null
  const countsUpdatedAt = countsSnapshot !== null ? new Date(countsSnapshot.updatedAtMs).toISOString() : null
  const healthy = firestoreOk && queueOk

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    region: REGION,
    db_connected: firestoreOk,
    queue_ready: queueOk,
    checks: {
      firestore: firestoreOk ? "ok" : "unavailable",
      queue: queueOk ? "ok" : "unavailable",
    },
    counts: countsSnapshot?.counts ?? { queuedJobs: 0 },
    counts_updated_at: countsUpdatedAt,
    counts_age_ms: countsAgeMs,
    checked_at: new Date(now).toISOString(),
  })
}

export async function healthHandler(req: Request, res: Response): Promise<void> {
  if (isLivenessRequest(req)) {
    livezHandler(req, res)
    return
  }
  await readyzHandler(req, res)
}

// Region set here, not by setGlobalOptions in index.ts: that runs after this object is built (deploy.test).
export const health = onRequest({ region: REGION }, healthHandler)
