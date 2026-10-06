import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  WHATSAPP_COMMANDS,
  WHATSAPP_GRAMMAR_HELP,
  whatsAppCommandName,
} from "@/services/d2-1/whatsapp"

/** The D2-1 command grammar is one exported table: the court-ops route and Gate G-2 both read it. */
describe("WhatsApp command grammar table", () => {
  it("lists the commands the channel accepts, with their usage", () => {
    expect(WHATSAPP_COMMANDS.map((c) => c.usage)).toEqual(["/matters", "/research <query>", "/ops queue"])
    expect(WHATSAPP_GRAMMAR_HELP).toBe(
      "unsupported command grammar; allowed: /matters, /research <query>, /ops queue"
    )
  })

  it.each([
    ["/matters", "matters"],
    ["  /MATTERS ", "matters"],
    ["/research PPC 302", "research"],
    ["/ops queue", "ops"],
    ["/ops   QUEUE", "ops"],
    ["/matters 123/2025", undefined],
    ["/research", undefined],
    ["/ops", undefined],
    ["/hearings", undefined],
    ["matters", undefined],
  ])("%j → %s", (text, name) => {
    expect(whatsAppCommandName(text)).toBe(name)
  })

  it("the court-ops route validates and dispatches through the table, with no grammar regex of its own", () => {
    const src = readFileSync(path.resolve(__dirname, "../app/api/d2/court-ops/route.ts"), "utf8")
    expect(src).toMatch(/whatsAppCommandName\(/)
    expect(src).not.toMatch(/\/\^\\\/\w+/)
  })
})
