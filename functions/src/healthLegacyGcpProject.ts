/**
 * Frozen reference for pre-R5FU-002 deployed health project resolution (regression tests only).
 * Do not use in production code paths.
 */
export function legacyExpectedGcpProjectId(env: Record<string, string | undefined>): string | undefined {
  const profile = env.SIKANDER_DEPLOY_PROFILE?.trim()
  const fromProfile =
    profile === "staging"
      ? "demo-sikander"
      : profile === "production"
        ? "sikander-legal-os-prod"
        : undefined
  if (fromProfile) return fromProfile
  const gcloud = env.GCLOUD_PROJECT?.trim()
  if (gcloud) return gcloud
  return env.GOOGLE_CLOUD_PROJECT?.trim() || undefined
}
