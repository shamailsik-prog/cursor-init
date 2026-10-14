import { describe, expect, it } from "vitest"
import { functionsApiBaseUrl } from "@/lib/console/functions-emulator-url"
import { listMattersViaFunctions } from "@/lib/console/functions-client"
import {
  HAS_AUTH_FIRESTORE_EMULATORS,
  HAS_FUNCTIONS_HTTP_EMULATOR,
  requireAuthFirestoreEmulators,
  requireFunctionsHttpEmulator,
} from "@/tests/helpers/emulator-require"
import { mintIdToken, uniq } from "@/tests/helpers/emulator-auth"

requireAuthFirestoreEmulators("F02 Functions HTTP emulator")
requireFunctionsHttpEmulator("F02 Functions HTTP emulator")

describe.skipIf(!HAS_AUTH_FIRESTORE_EMULATORS || !HAS_FUNCTIONS_HTTP_EMULATOR)(
  "F02: console client against Functions HTTP emulator",
  () => {
    it("listMatters succeeds over HTTP with a valid token and rejects cross-firm X-Firm-Id", async () => {
      const base = functionsApiBaseUrl()
      expect(base).toMatch(/^http:\/\//)

      const firmId = uniq("firm")
      const otherFirm = uniq("firm")
      const { token } = await mintIdToken({
        firmId,
        role: "partner",
        clearanceLevel: "privileged-restricted",
      })

      const ok = await listMattersViaFunctions({ idToken: token, firmId }, { limit: 5 })
      expect(ok.status).toBe(200)
      expect(ok.body).toMatchObject({ items: expect.any(Array) })

      const crossFirm = await listMattersViaFunctions(
        { idToken: token, firmId: otherFirm },
        { limit: 5 }
      )
      expect(crossFirm.status).toBe(403)
      expect(crossFirm.body).toMatchObject({ error: { code: "firm_mismatch" } })
    })
  }
)
