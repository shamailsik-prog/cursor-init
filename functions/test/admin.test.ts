import { deleteApp, getApps, initializeApp } from "firebase-admin/app"
import { afterAll, describe, expect, it } from "vitest"
import { adminApp } from "../src/admin"

describe("adminApp", () => {
  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)))
  })

  it("returns the [DEFAULT] app even when a named app was initialised first", () => {
    initializeApp({ projectId: "demo-other" }, "secondary")
    expect(adminApp().name).toBe("[DEFAULT]")
    expect(adminApp()).toBe(adminApp())
  })
})
