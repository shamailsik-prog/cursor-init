import { logger } from "firebase-functions"

/**
 * Deploy-time settings read from the environment (functions/.env.<projectId>),
 * shared by `api` and the callables.
 *
 * - TRUSTED_PROXY_HOPS: proxies of ours in front of Google's front end that
 *   append to X-Forwarded-For (see clientIp in http/rateLimit.ts). Default 0.
 * - SIKANDER_INGRESS_SETTINGS: the functions' ingress. Default ALLOW_ALL (direct
 *   URLs). Behind a load balancer set ALLOW_INTERNAL_AND_GCLB, so clients cannot
 *   bypass the proxy and choose their own X-Forwarded-For.
 */

type Env = Record<string, string | undefined>

export const INGRESS_VALUES = ["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"] as const
export type Ingress = (typeof INGRESS_VALUES)[number]

/** TRUSTED_PROXY_HOPS as a non-negative integer; anything else counts as 0. */
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

/** A warning when proxy hops are trusted but direct traffic is still allowed (the hop key is then spoofable). */
export function ingressWarning(env: Env = process.env): string | undefined {
  if (trustedProxyHops(env) > 0 && ingressSettings(env) === "ALLOW_ALL") {
    return (
      "TRUSTED_PROXY_HOPS > 0 but SIKANDER_INGRESS_SETTINGS is ALLOW_ALL: direct requests can bypass the proxy " +
      "and forge the trusted X-Forwarded-For hop; set SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB"
    )
  }
  return undefined
}

export const INGRESS_SETTINGS: Ingress = ingressSettings()

const warning = ingressWarning()
if (warning) logger.warn(warning)
