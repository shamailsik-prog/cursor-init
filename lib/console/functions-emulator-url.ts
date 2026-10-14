const REGION = "asia-south1"

/** Base URL for the deployed or emulated `api` HTTPS function (path suffix is `/api/...`). */
export function functionsApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit =
    env.NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL?.trim() ||
    env.SIKANDER_FUNCTIONS_API_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, "")

  const emulatorHost =
    env.FIREBASE_FUNCTIONS_EMULATOR_HOST?.trim() || env.FUNCTIONS_EMULATOR_HOST?.trim()
  if (emulatorHost) {
    const host = emulatorHost.replace(/^https?:\/\//, "")
    const project =
      env.GCLOUD_PROJECT?.trim() || env.FIREBASE_PROJECT_ID?.trim() || "demo-sikander"
    return `http://${host}/${project}/${REGION}/api`
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin
  }
  return ""
}
