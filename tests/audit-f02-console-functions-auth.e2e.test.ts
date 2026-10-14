import { describe, expect, it } from "vitest"
import { listMattersViaFunctions } from "@/lib/console/functions-client"
import {
  HAS_AUTH_FIRESTORE_EMULATORS,
  requireAuthFirestoreEmulators,
} from "@/tests/helpers/emulator-require"
import { EMULATORS, mintIdToken, uniq } from "@/tests/helpers/emulator-auth"
import { functionsRouterFetch } from "@/tests/helpers/functions-router-fetch"

requireAuthFirestoreEmulators("F02 console Functions client (in-process router)")

describe.skipIf(!HAS_AUTH_FIRESTORE_EMULATORS && !EMULATORS)(
  "F02: console Functions client authentication (in-process router)",
  () => {
    it("returns 200 with a list payload for a valid token and rejects missing, bad, and cross-firm tokens", async () => {
      const firmId = uniq("firm")
      const otherFirm = uniq("firm")
      const { token } = await mintIdToken({
        firmId,
        role: "partner",
        clearanceLevel: "privileged-restricted",
      })
      const auth = { idToken: token, firmId }

      const ok = await listMattersViaFunctions(auth, { limit: 5 }, functionsRouterFetch)
      expect(ok.status).toBe(200)
      expect(ok.body).toMatchObject({
        items: expect.any(Array),
      })

      const noToken = await listMattersViaFunctions(
        { idToken: null, firmId },
        { limit: 5 },
        functionsRouterFetch
      )
      expect(noToken.status).toBe(401)
      expect(noToken.body).toMatchObject({ error: { code: "missing_token" } })

      const badToken = await listMattersViaFunctions(
        { idToken: "not-a-jwt", firmId },
        { limit: 5 },
        functionsRouterFetch
      )
      expect(badToken.status).toBe(401)
      expect(badToken.body).toMatchObject({ error: { code: "invalid_token" } })

      const crossFirm = await listMattersViaFunctions(
        { idToken: token, firmId: otherFirm },
        { limit: 5 },
        functionsRouterFetch
      )
      expect(crossFirm.status).toBe(403)
      expect(crossFirm.body).toMatchObject({ error: { code: "firm_mismatch" } })
    })
  }
)
