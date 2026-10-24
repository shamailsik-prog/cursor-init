/** F32: explicit Cloud Functions v2 runtime defaults (manifest parity). */
export const REGION = "asia-south1" as const
export const RUNTIME_GCP_PROJECT_ID = "demo-sikander" as const
export const RUNTIME_SERVICE_ACCOUNT = "sikander-functions@" as const
export const RUNTIME_SERVICE_ACCOUNT_EMAIL =
  `${RUNTIME_SERVICE_ACCOUNT}${RUNTIME_GCP_PROJECT_ID}.iam.gserviceaccount.com` as const

export const RUNTIME_DEFAULTS = {
  region: REGION,
  serviceAccount: RUNTIME_SERVICE_ACCOUNT,
  memory: "256MiB" as const,
  concurrency: 1,
  minInstances: 0,
} as const

export const INTERNAL_ONLY = "ALLOW_INTERNAL_ONLY" as const
