import { describe, expect, it, vi } from "vitest"

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe("health liveness (FA-F44-001)", () => {
  it("responds 200 with probe liveness and no async dependency work", async () => {
    const { createLivenessHandler } = await import("../src/health")
    const handler = createLivenessHandler()
    const res = mockRes()
    handler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "ok", probe: "liveness" })
  })
})
