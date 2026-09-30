import { describe, expect, it, vi } from "vitest"
import { healthHandler } from "../src/health"

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}

describe("health handler", () => {
  it("responds 200 with status ok and region asia-south1", () => {
    const res = mockRes()
    healthHandler({} as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "ok", region: "asia-south1" })
  })
})
