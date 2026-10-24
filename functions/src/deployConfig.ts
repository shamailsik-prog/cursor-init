import { logger } from "firebase-functions"

/**
 * Deploy-time settings read from the environment (functions/.env.<projectId>),
 * used by `api`.
 */

type Env = Record<string, string | undefined>

export const INGRESS_VALUES = ["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"] as const
export type Ingress = (typeof INGRESS_VALUES)[number]

export type ContractCode =
  | "ingress_not_set"
  | "ingress_invalid"
  | "proxy_hops_invalid"
  | "proxy_trust_with_open_ingress"
  | "gclb_ingress_without_trusted_hop"

export const CONTRACT_ALERT = "deploy.contract_violation"

export class DeployContractError extends Error {
  readonly codes: ContractCode[]
  constructor(codes: ContractCode[]) {
    super(`deploy contract violation: ${codes.join(", ")}`)
    this.name = "DeployContractError"
    this.codes = codes
  }
}

/** Production bundle (NODE_ENV production, not the Functions emulator). */
export function isDeployedRuntime(env: Env = process.env): boolean {
  const emulator = (env.FUNCTIONS_EMULATOR ?? "").trim() === "true"
  const firebaseConfig = (env.FIREBASE_CONFIG ?? "").trim() !== ""
  if (emulator && firebaseConfig) return false
  return env.NODE_ENV === "production" && !emulator
}

/** TRUSTED_PROXY_HOPS as a non-negative integer; anything else counts as 0 for rate limiting. */
export function trustedProxyHops(env: Env = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS ?? ""
  return /^\d+$/.test(raw) ? Number(raw) : 0
}

/** SIKANDER_INGRESS_SETTINGS, default ALLOW_ALL. An unknown value throws, so a typo fails the deploy. */
export function ingressSettings(env: Env = process.env): Ingress {
  const raw = env.SIKANDER_INGRESS_SETTINGS
  if (raw === undefined || raw === "") return "ALLOW_ALL"
  if ((INGRESS_VALUES as readonly string[]).includes(raw)) return raw as Ingress
  throw new Error(`SIKANDER_INGRESS_SETTINGS must be one of ${INGRESS_VALUES.join(", ")}`)
}

export function deployContractViolations(env: Env, ctx: { deployed: boolean }): ContractCode[] {
  const codes: ContractCode[] = []
  const hopsRaw = env.TRUSTED_PROXY_HOPS ?? ""
  let hops = 0
  if (hopsRaw !== "") {
    if (!/^(0|[1-9]\d*)$/.test(hopsRaw)) codes.push("proxy_hops_invalid")
    else hops = Number(hopsRaw)
  }

  const ingressRaw = env.SIKANDER_INGRESS_SETTINGS
  let ingress: Ingress = "ALLOW_ALL"
  if (ingressRaw === undefined || ingressRaw === "") {
    if (ctx.deployed) codes.push("ingress_not_set")
  } else if (!(INGRESS_VALUES as readonly string[]).includes(ingressRaw)) {
    codes.push("ingress_invalid")
  } else {
    ingress = ingressRaw as Ingress
  }

  if (ingress === "ALLOW_ALL" && hops > 0) codes.push("proxy_trust_with_open_ingress")
  if (ingress === "ALLOW_INTERNAL_AND_GCLB" && hops === 0) codes.push("gclb_ingress_without_trusted_hop")
  return codes
}

function enforceContractAtLoad(): void {
  const codes = deployContractViolations(process.env, { deployed: isDeployedRuntime() })
  if (codes.length > 0) {
    logger.error(CONTRACT_ALERT, { codes })
    throw new DeployContractError(codes)
  }
}

enforceContractAtLoad()

export const INGRESS_SETTINGS: Ingress = ingressSettings()
