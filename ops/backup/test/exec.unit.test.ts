import { describe, expect, it } from "vitest"
import { runCommand } from "../lib/exec"

describe("runCommand pgPrefix", () => {
  it("prepends the argv prefix (R19)", async () => {
    const r = await runCommand(["echo", "ok"], { pgPrefix: ["env", "X=1"] })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe("ok")
  })
})
