import { onRequest } from "firebase-functions/v2/https"
import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"
import { deployContractViolations, INGRESS_SETTINGS, isDeployedRuntime, type Ingress } from "./deployConfig"
import { REGION, RUNTIME_DEFAULTS, RUNTIME_SERVICE_ACCOUNT } from "./runtimeOptions"

export { REGION } from "./runtimeOptions"

/**
 * Pinned timeout for `api`. The idempotency lease
 * (http/idempotency.ts) must outlive it, or a slow but live request could be
 * taken over and run twice; that module asserts this when it loads.
 */
export const FUNCTION_TIMEOUT_SECONDS = 120

export type Verdict = "ok" | "violated" | "unknown"

export type ContractKey = "region" | "database_location" | "ingress" | "proxy_trust" | "required_env" | "runtime_identity"

const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1/instance/"
const METADATA_TTL_MS = 300_000
const METADATA_TIMEOUT_MS = 500
const DEPLOYED_API_INGRESS: Ingress = "ALLOW_INTERNAL_AND_GCLB"

function deployedGcpProjectId(env: Record<string, string | undefined>): string | undefined {
  const gcloud = env.GCLOUD_PROJECT?.trim()
  if (gcloud) return gcloud
  const google = env.GOOGLE_CLOUD_PROJECT?.trim()
  if (google) return google
  return undefined
}

function expectedRuntimeServiceAccountEmail(env: Record<string, string | undefined>): string | undefined {
  const projectId = deployedGcpProjectId(env)
  if (!projectId) return undefined
  return `${RUNTIME_SERVICE_ACCOUNT}${projectId}.iam.gserviceaccount.com`
}

type Metadata = { region?: string; serviceAccount?: string }

let metadataCache: { at: number; value: Metadata | null } | null = null

async function defaultMetadataProbe(): Promise<Metadata> {
  const headers = { "Metadata-Flavor": "Google" }
  const read = async (path: string): Promise<string | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
    try {
      const res = await fetch(`${METADATA_URL}${path}`, { headers, signal: controller.signal })
      if (!res.ok) return undefined
      return (await res.text()).trim() || undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  const [region, serviceAccount] = await Promise.all([read("region"), read("service-account/default/email")])
  return { region, serviceAccount }
}

async function metadataWithCache(now: () => number, probe: () => Promise<Metadata>): Promise<Metadata> {
  if (metadataCache && now() - metadataCache.at < METADATA_TTL_MS) return metadataCache.value ?? {}
  const value = await Promise.race<Metadata>([
    probe(),
    new Promise((resolve) => {
      setTimeout(() => resolve({}), METADATA_TIMEOUT_MS)
    }),
  ])
  metadataCache = { at: now(), value }
  return value
}

function parseLocationId(env: Record<string, string | undefined>): string | undefined {
  const raw = env.FIREBASE_CONFIG
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { locationId?: string }
    return typeof parsed.locationId === "string" ? parsed.locationId : undefined
  } catch {
    return undefined
  }
}

export async function contractReport(deps?: {
  env?: Record<string, string | undefined>
  deployed?: boolean
  metadata?: () => Promise<Metadata>
  now?: () => number
}): Promise<Record<ContractKey, Verdict>> {
  const env = deps?.env ?? process.env
  const deployed = deps?.deployed ?? isDeployedRuntime(env)
  const now = deps?.now ?? (() => Date.now())
  const meta = await metadataWithCache(now, deps?.metadata ?? defaultMetadataProbe)

  const ingressForCheck =
    env.SIKANDER_INGRESS_SETTINGS !== undefined && env.SIKANDER_INGRESS_SETTINGS !== ""
      ? env.SIKANDER_INGRESS_SETTINGS
      : INGRESS_SETTINGS
  const synthEnv = { ...env, SIKANDER_INGRESS_SETTINGS: ingressForCheck }
  const contractCodes = deployContractViolations(synthEnv, { deployed })
  const proxyOk = !contractCodes.some(
    (c) => c === "proxy_hops_invalid" || c === "proxy_trust_with_open_ingress" || c === "gclb_ingress_without_trusted_hop"
  )

  const locationId = parseLocationId(env)
  const regionVerdict: Verdict = meta.region ? (meta.region === REGION ? "ok" : "violated") : "unknown"
  const dbVerdict: Verdict = locationId ? (locationId === REGION ? "ok" : "violated") : "unknown"
  const expectedSa = expectedRuntimeServiceAccountEmail(env)
  const identityVerdict: Verdict =
    meta.serviceAccount === undefined || expectedSa === undefined
      ? "unknown"
      : meta.serviceAccount === expectedSa
        ? "ok"
        : "violated"

  const ingressVerdict: Verdict = deployed
    ? ingressForCheck === DEPLOYED_API_INGRESS
      ? "ok"
      : ingressForCheck
        ? "violated"
        : "unknown"
    : "unknown"

  const requiredEnv: Verdict = deployed
    ? env.SIKANDER_INGRESS_SETTINGS && (["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"] as const).includes(env.SIKANDER_INGRESS_SETTINGS as Ingress)
      ? "ok"
      : "violated"
    : "unknown"

  return {
    region: regionVerdict,
    database_location: dbVerdict,
    ingress: ingressVerdict,
    proxy_trust: proxyOk ? "ok" : "violated",
    required_env: requiredEnv,
    runtime_identity: identityVerdict,
  }
}

export function createHealthHandler(deps?: Parameters<typeof contractReport>[0]) {
  return async (_req: Request, res: Response): Promise<void> => {
    const env = deps?.env ?? process.env
    const deployed = deps?.deployed ?? isDeployedRuntime(env)
    const contract = await contractReport(deps)
    const violated = Object.values(contract).some((v) => v === "violated")
    const unknownWhenDeployed = deployed && Object.values(contract).some((v) => v === "unknown")
    const unhealthy = violated || unknownWhenDeployed
    res.status(unhealthy ? 503 : 200).json({
      status: unhealthy ? "unhealthy" : "ok",
      region: REGION,
    })
  }
}

export const healthHandler = createHealthHandler()

export const health = onRequest(
  {
    ...RUNTIME_DEFAULTS,
    maxInstances: 2,
    timeoutSeconds: 60,
    ingressSettings: "ALLOW_ALL",
  },
  healthHandler
)
