import { GoogleAuth } from "google-auth-library"
import { adminDb } from "./admin"
import { isDeployedRuntime } from "./deployConfig"
import { REGION } from "./runtimeOptions"

export type DependencyKey = "firestore" | "job_queue"
export type DependencyVerdict = "ok" | "failed"

export const DEPENDENCY_PROBE_TIMEOUT_MS = 2_000

const JOB_WORKER_QUEUE_ID = "jobWorker"

function projectIdFromEnv(env: Record<string, string | undefined>): string | undefined {
  const gcloud = env.GCLOUD_PROJECT?.trim()
  if (gcloud) return gcloud
  const google = env.GOOGLE_CLOUD_PROJECT?.trim()
  if (google) return google
  return undefined
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    work,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("dependency probe timeout")), ms)
    }),
  ])
}

async function defaultFirestoreProbe(): Promise<void> {
  await adminDb().collection("jobs").limit(1).get()
}

async function defaultJobQueueProbe(env: Record<string, string | undefined>): Promise<void> {
  const projectId = projectIdFromEnv(env)
  if (!projectId) throw new Error("missing project id for job queue probe")
  const url = `https://cloudtasks.googleapis.com/v2/projects/${projectId}/locations/${REGION}/queues/${JOB_WORKER_QUEUE_ID}`
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
  const client = await auth.getClient()
  const token = await client.getAccessToken()
  if (!token.token) throw new Error("missing access token for job queue probe")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEPENDENCY_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.token}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`job queue probe http ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

export type DependencyProbeDeps = {
  env?: Record<string, string | undefined>
  deployed?: boolean
  probeFirestore?: () => Promise<void>
  probeJobQueue?: () => Promise<void>
  timeoutMs?: number
}

/** Readiness dependency probes (Firestore + Cloud Tasks job queue). Omitted when not deployed. */
export async function dependencyReport(
  deps?: DependencyProbeDeps,
): Promise<Record<DependencyKey, DependencyVerdict> | null> {
  const env = deps?.env ?? process.env
  const deployed = deps?.deployed ?? isDeployedRuntime(env)
  if (!deployed) return null

  const timeoutMs = deps?.timeoutMs ?? DEPENDENCY_PROBE_TIMEOUT_MS
  const firestoreProbe = deps?.probeFirestore ?? defaultFirestoreProbe
  const jobQueueProbe = deps?.probeJobQueue ?? (() => defaultJobQueueProbe(env))

  const run = async (probe: () => Promise<void>): Promise<DependencyVerdict> => {
    try {
      await withTimeout(probe(), timeoutMs)
      return "ok"
    } catch {
      return "failed"
    }
  }

  const [firestore, job_queue] = await Promise.all([run(firestoreProbe), run(jobQueueProbe)])
  return { firestore, job_queue }
}
