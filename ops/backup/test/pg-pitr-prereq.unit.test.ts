import { describe, expect, it, vi } from "vitest"
import * as exec from "../lib/exec"
import { assertPitrClientTools } from "../postgres/pitrPrereq"

describe("assertPitrClientTools", () => {
  it("throws when initdb/pg_basebackup are missing", async () => {
    vi.spyOn(exec, "runCommand").mockResolvedValue({ code: 1, stdout: "", stderr: "missing" })
    await expect(assertPitrClientTools()).rejects.toThrow(/prerequisites missing/i)
    vi.restoreAllMocks()
  })
})
