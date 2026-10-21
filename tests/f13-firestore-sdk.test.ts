// FA-F13-012: the one Firestore SDK detector (platform/persistence/firestoreDbModular.ts) recognises firebase-admin of
// either copy (Cloud Functions 13.x, the Next server 14.x), and each instance gets the sentinel of its own copy.
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { Firestore as RootFirestore, FieldValue as RootFieldValue } from "firebase-admin/firestore"
import { initializeApp, deleteApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { describe, expect, it } from "vitest"
import { firestoreSdkOf, serverTimestampFor } from "@/platform/persistence/firestoreDbModular"

// The Cloud Functions copy exists only where functions/ dependencies are installed (CI's unit job installs the root
// only; the emulator contract test tests/f13-slice2.e2e.firestore.test.ts runs both copies there).
const FUNCTIONS_ADMIN = path.join(process.cwd(), "functions", "node_modules", "firebase-admin", "package.json")
const HAS_FUNCTIONS_ADMIN = existsSync(FUNCTIONS_ADMIN)
const functionsRequire = createRequire(path.join(process.cwd(), "functions", "package.json"))
type AdminModule = { Firestore: new (s: object) => object; FieldValue: { serverTimestamp(): object } }
const fnAdmin = (HAS_FUNCTIONS_ADMIN ? functionsRequire("firebase-admin/firestore") : null) as AdminModule
const version = (dir: string) => (functionsRequire(path.join(process.cwd(), dir, "node_modules", "firebase-admin", "package.json")) as { version: string }).version

describe.runIf(HAS_FUNCTIONS_ADMIN)("FA-F13-012: one Firestore SDK detector across firebase-admin copies", () => {
  it("the two copies are distinct (13.x in functions, 14.x at the root)", () => {
    expect(version("functions")).toMatch(/^13\./)
    expect(version(".")).toMatch(/^14\./)
    expect(fnAdmin.Firestore).not.toBe(RootFirestore)
  })

  it("an instance of either copy is admin and gets its own copy's server-timestamp sentinel", () => {
    const root = new RootFirestore({ projectId: "demo-sikander" })
    const fn = new fnAdmin.Firestore({ projectId: "demo-sikander" })
    expect(firestoreSdkOf(root)).toBe("admin")
    expect(firestoreSdkOf(fn)).toBe("admin")
    const rootSentinel = serverTimestampFor(root as never)
    const fnSentinel = serverTimestampFor(fn as never)
    expect(rootSentinel).toBeInstanceOf(Object.getPrototypeOf(RootFieldValue.serverTimestamp()).constructor)
    expect(fnSentinel).toBeInstanceOf(Object.getPrototypeOf(fnAdmin.FieldValue.serverTimestamp()).constructor)
    expect(fnSentinel).not.toBeInstanceOf(Object.getPrototypeOf(RootFieldValue.serverTimestamp()).constructor)
  })

})

describe("FA-F13-012: the Firestore SDK detector", () => {
  it("a modular client instance is client; an unbranded object with collection() is a namespaced double; others are unknown", async () => {
    const app = initializeApp({ projectId: "demo-sikander" }, `f13-sdk-${Date.now()}`)
    try {
      expect(firestoreSdkOf(getFirestore(app))).toBe("client")
    } finally {
      await deleteApp(app)
    }
    expect(firestoreSdkOf({ collection: () => null })).toBe("namespaced")
    expect(firestoreSdkOf({ collection: () => null, _delegate: { type: "firestore" } })).toBe("client-compat")
    expect(firestoreSdkOf({})).toBeNull()
    expect(firestoreSdkOf(null)).toBeNull()
  })
})
