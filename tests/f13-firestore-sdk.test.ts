// FA-F13-012: the one Firestore SDK detector (platform/persistence/firestoreDbModular.ts) recognises firebase-admin of
// either copy (Cloud Functions 13.x, the Next server 14.x), and each instance gets the sentinel of its own copy.
import { createRequire } from "node:module"
import path from "node:path"
import { Firestore as RootFirestore, FieldValue as RootFieldValue } from "firebase-admin/firestore"
import { initializeApp, deleteApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { describe, expect, it } from "vitest"
import { firestoreSdkOf, serverTimestampFor } from "@/platform/persistence/firestoreDbModular"

const functionsRequire = createRequire(path.join(process.cwd(), "functions", "package.json"))
const fnAdmin = functionsRequire("firebase-admin/firestore") as { Firestore: new (s: object) => object; FieldValue: { serverTimestamp(): object } }
const version = (dir: string) => (functionsRequire(path.join(process.cwd(), dir, "node_modules", "firebase-admin", "package.json")) as { version: string }).version

describe("FA-F13-012: one Firestore SDK detector across firebase-admin copies", () => {
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
