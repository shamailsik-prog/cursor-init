import { describe, expect, it } from "vitest"
import { createF02Router } from "@/functions/src/http/f02RouterBoundary"

/**
 * FA-F18-014: the F02 boundary router must mount only F02_NEXT_AUTHORITY_ROUTES, not committeeBrain.
 */

function mockRes() {
  let status = 0
  let body: unknown
  const res = {
    status(code: number) {
      status = code
      return res
    },
    set() {
      return res
    },
    json(payload: unknown) {
      body = payload
    },
  }
  return {
    res,
    out: () => ({ status, body }),
  }
}

describe("audit F18: F02 router boundary (FA-F18-014)", () => {
  it("returns 404 route_not_found for committeeBrain (not an F02 route)", async () => {
    const router = createF02Router()
    const { res, out } = mockRes()
    await router(
      {
        method: "POST",
        path: "/api/platform/brain/committeeBrain",
        headers: { "content-type": "application/json" },
        body: {},
        rawBody: Buffer.from("{}"),
        ip: "127.0.0.1",
      } as never,
      res as never
    )
    const result = out()
    expect(result.status).toBe(404)
    expect((result.body as { error?: { code?: string } }).error?.code).toBe("route_not_found")
  })
})
