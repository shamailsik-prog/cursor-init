import { describe, expect, it } from "vitest"
import { runCommand } from "../lib/exec"

describe("runCommand UTF-8", () => {
  it("decodes a multi-byte character split across stdout chunks", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0xda]));",
      "setTimeout(() => {",
      "  process.stdout.write(Buffer.from([0xa9]));",
      "  process.stdout.end();",
      "}, 40);",
    ].join("")
    const res = await runCommand(["node", "-e", script], {
      exactEnv: true,
      env: { ...process.env, NODE_ENV: "test" },
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("ک")
    expect(res.stdout).not.toContain("\uFFFD")
  })
})
