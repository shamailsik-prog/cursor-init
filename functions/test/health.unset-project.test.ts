import { afterEach, describe, expect, it, vi } from "vitest"

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

/** Pre-R5FU-002: health fell back to GCLOUD_PROJECT when deploy profile was unset. */
function legacyExpectedGcpProjectId(env: Record<string, string | undefined>): string | undefined {
  const profile = env.SIKANDER_DEPLOY_PROFILE?.trim()
  const fromProfile = profile === "staging"
    ? "demo-sikander"
    : profile === "production"
      ? "sikander-legal-os-prod"
      : undefined
  if (fromProfile) return fromProfile
  const gcloud = env.GCLOUD_PROJECT?.trim()
  if (gcloud) return gcloud
  return env.GOOGLE_CLOUD_PROJECT?.trim() || undefined
}

describe("health runtime identity without GCP project (R5-005 / R5FU-002)", () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("legacy fallback would derive project from GCLOUD without deploy profile (regression detector)", () => {
    const env = {
      GCLOUD_PROJECT: "demo-sikander",
      GOOGLE_CLOUD_PROJECT: undefined,
    }
    expect(legacyExpectedGcpProjectId(env)).toBe("demo-sikander")
  })

  it("responds 503 when deployed with profile but no runtime GCP project id", async () => {
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: {
        SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB",
        TRUSTED_PROXY_HOPS: "1",
        FIREBASE_CONFIG: '{"locationId":"asia-south1"}',
        SIKANDER_DEPLOY_PROFILE: "staging",
      },
      deployed: true,
      metadata: async () => ({
        region: "asia-south1",
        serviceAccount: "sikander-functions@demo-sikander.iam.gserviceaccount.com",
      }),
      now: () => 0,
    })
    const res = mockRes()
    await handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it("responds 503 when deployed without SIKANDER_DEPLOY_PROFILE even if GCLOUD_PROJECT is set", async () => {
    const { createHealthHandler } = await import("../src/health")
    const handler = createHealthHandler({
      env: {
        SIKANDER_INGRESS_SETTINGS: "ALLOW_INTERNAL_AND_GCLB",
        TRUSTED_PROXY_HOPS: "1",
        FIREBASE_CONFIG: '{"locationId":"asia-south1"}',
        GCLOUD_PROJECT: "demo-sikander",
      },
      deployed: true,
      metadata: async () => ({
        region: "asia-south1",
        serviceAccount: "sikander-functions@demo-sikander.iam.gserviceaccount.com",
      }),
      now: () => 0,
    })
    const res = mockRes()
    await handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(503)
  })
})
