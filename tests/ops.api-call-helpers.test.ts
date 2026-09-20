import { describe, expect, it, vi } from "vitest"
import { formatApiErrorMessage, runApiCallAllowingStatuses } from "@/app/ops/api-call-helpers"

describe("ops status-tolerant API call helper", () => {
  it("returns non-ok results when the status is explicitly allowed", async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      status: 422,
      body: { error: "validation blocked by deterministic guard" },
    }))

    const result = await runApiCallAllowingStatuses({
      step: "Batch E: annexure checkpoint partner signoff",
      allowedStatuses: [200, 403, 404, 422],
      execute,
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
  })

  it("throws with server-provided error when status is not allowed", async () => {
    await expect(
      runApiCallAllowingStatuses({
        step: "Batch F: set closure SLA window config",
        allowedStatuses: [200, 403, 404, 422],
        execute: async () => ({
          ok: false,
          status: 500,
          body: { error: "upstream exploded" },
        }),
      })
    ).rejects.toThrow("upstream exploded")
  })

  it("falls back to a deterministic step/status error message", () => {
    expect(formatApiErrorMessage("Batch D: create client entity", 400, { message: "bad request" })).toBe(
      "Batch D: create client entity failed with 400"
    )
  })
})
