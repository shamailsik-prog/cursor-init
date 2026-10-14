import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { firestorePersistenceConfigured } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

const env = process.env as Record<string, string | undefined>
const saved = {
  mode: env.SIKANDER_PERSISTENCE_MODE,
  nodeEnv: env.NODE_ENV,
  firestoreHost: env.FIRESTORE_EMULATOR_HOST,
  creds: env.GOOGLE_APPLICATION_CREDENTIALS,
  project: env.FIREBASE_PROJECT_ID,
  gcloud: env.GOOGLE_CLOUD_PROJECT,
}

beforeEach(() => {
  resetRuntimeStoreForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
  delete env.FIRESTORE_EMULATOR_HOST
  delete env.GOOGLE_APPLICATION_CREDENTIALS
  delete env.FIREBASE_PROJECT_ID
  delete env.GOOGLE_CLOUD_PROJECT
  env.SIKANDER_PERSISTENCE_MODE = "firestore"
  env.NODE_ENV = "test"
})

afterEach(() => {
  restore("SIKANDER_PERSISTENCE_MODE", saved.mode)
  restore("NODE_ENV", saved.nodeEnv)
  restore("FIRESTORE_EMULATOR_HOST", saved.firestoreHost)
  restore("GOOGLE_APPLICATION_CREDENTIALS", saved.creds)
  restore("FIREBASE_PROJECT_ID", saved.project)
  restore("GOOGLE_CLOUD_PROJECT", saved.gcloud)
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete env[key]
  else env[key] = value
}

describe("F01: firestore persistence misconfiguration", () => {
  it("treats project id without credentials as not configured", () => {
    env.FIREBASE_PROJECT_ID = "demo-only-project-id"
    expect(firestorePersistenceConfigured(env as NodeJS.ProcessEnv)).toBe(false)
  })

  it("returns 503 from a real route when firestore mode has no emulator or credentials", async () => {
    env.FIREBASE_PROJECT_ID = "demo-only-project-id"
    expect(firestorePersistenceConfigured(env as NodeJS.ProcessEnv)).toBe(false)

    const res = await mattersGet(
      new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=5&cursor=0")
    )
    expect(res.status).toBe(503)
    const json = (await res.json()) as { code?: string; error?: string }
    expect(json.code).toBe("PERSISTENCE_NOT_CONFIGURED")
    expect(json.error).toMatch(/GOOGLE_APPLICATION_CREDENTIALS|FIRESTORE_EMULATOR_HOST/)
  })
})
