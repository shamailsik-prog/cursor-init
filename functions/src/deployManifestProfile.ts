/**
 * Deploy profile → GCP project id (must match infra/deploy-manifest.json environments.*.gcpProjectId).
 */
export const DEPLOY_PROFILE_GCP_PROJECT_ID: Readonly<Record<string, string>> = {
  staging: "demo-sikander",
  production: "sikander-legal-os-prod",
}

export function gcpProjectIdForDeployProfile(profile: string | undefined): string | undefined {
  if (!profile?.trim()) return undefined
  return DEPLOY_PROFILE_GCP_PROJECT_ID[profile.trim()]
}
