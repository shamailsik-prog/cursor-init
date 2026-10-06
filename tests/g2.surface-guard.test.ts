import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { guardViolations, helperModulesOf, helperViolations } from "./g2/guard"

/**
 * Gate G-2 static guard (fix round 2, N1): the routes in G-2 scope read
 * selectors only through their declared surface (platform/http/surface.ts),
 * and the D2-1 WhatsApp handler dispatches only through WHATSAPP_COMMANDS.
 * Each of the review's code forms that used to slip past the inventory is
 * rejected here; a new body field (form J) is caught by the G-2 inventory
 * (tests/g2.cross-firm.test.ts), since body fields come from the surface.
 */

const ROOT = path.resolve(__dirname, "..")

export const GUARDED_ROUTES = [
  "app/api/d1/clients/route.ts",
  "app/api/d1/reporting/route.ts",
  "app/api/d1/matters/route.ts",
  "app/api/d1/documents/route.ts",
  "app/api/d1/document-workflow/route.ts",
  "app/api/d2/court-ops/route.ts",
  "app/api/p5/tenancy/route.ts",
]
const GUARDED_HANDLERS = ["services/d2-1/whatsapp.ts"]

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8")

const insertAfter = (src: string, anchor: string, text: string) => {
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`anchor not found: ${anchor}`)
  return src.slice(0, i + anchor.length) + text + src.slice(i + anchor.length)
}

/** The review's forms (task-8-rereview.md N1), applied to the real sources. */
const FORMS: Array<[string, string, (src: string) => string]> = [
  ["A destructured action", "app/api/d1/clients/route.ts", (s) => insertAfter(s, "const parsed: Body = body.data", '\n  const { action } = parsed\n  if (action === "dump") return NextResponse.json({})')],
  ["A' multi-line destructured action", "app/api/d1/clients/route.ts", (s) => insertAfter(s, "const parsed: Body = body.data", '\n  const {\n    action,\n  } = parsed\n  if (action === "dump") return NextResponse.json({})')],
  ["B bracket access", "app/api/d1/clients/route.ts", (s) => insertAfter(s, "const parsed: Body = body.data", '\n  if ((raw.data as Record<string, unknown>)["action"] === "dump") return NextResponse.json({})')],
  ["C switch on the view param", "app/api/d1/reporting/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  switch (url.searchParams.get("view")) {\n    case "dump":\n      break\n  }')],
  ["D view read into another variable", "app/api/d1/reporting/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  const v = url.searchParams.get("view")\n  if (v === "dump") return NextResponse.json({})')],
  ["E view from a const list via a parser", "app/api/d1/document-workflow/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  const EXTRA_VIEWS = ["dump_all"]\n  if (EXTRA_VIEWS.includes(url.searchParams.get("view") ?? "")) return NextResponse.json({})')],
  ["G header-selected read", "app/api/d1/matters/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  if (request.headers.get("x-view") === "all") return NextResponse.json({})')],
  ["H WhatsApp switch on the text", "app/api/d2/court-ops/route.ts", (s) => insertAfter(s, "const text = parsed.command.trim()", '\n      switch (text) {\n        case "/hearings":\n          break\n      }')],
  ["H' WhatsApp literal in the handler", "services/d2-1/whatsapp.ts", (s) => insertAfter(s, "const name = whatsAppCommandName(command)", '\n  if (command.trim() === "/hearings") return { ok: true }')],
  ["K query re-parsed from the URL", "app/api/d1/documents/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  const id = new URLSearchParams(request.url.split("?")[1]).get("id")')],
  ["nextUrl", "app/api/d1/clients/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  const id = (request as unknown as { nextUrl: URL }).nextUrl')],
  // Built from parts: ci_gates/check_idempotency.py scans for exported write handlers.
  ["X9 headers spread through an alias", "app/api/d1/clients/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", "\n  const r = request\n  const all = Object.fromEntries(r.headers)")],
  ["X10 request.cookies", "app/api/d1/matters/route.ts", (s) => insertAfter(s, "const url = new URL(request.url)", '\n  const scope = (request as unknown as { cookies: Map<string, string> }).cookies.get("scope")')],
  ["X11 next/headers headers()", "app/api/d1/reporting/route.ts", (s) => `import { headers } from "next/headers"\n${s}`],
  ["X11' next/headers cookies()", "app/api/p5/tenancy/route.ts", (s) => `import { cookies } from "next/headers"\n${s}`],
  ["a withSession call without the surface", "app/api/p5/tenancy/route.ts", (s) => `${s}\n${["export async function", "PUT(request: Request) {"].join(" ")}\n  return withSession(request, handlePost)\n}\n`],
]

/** X6: a helper module a G-2 route imports reads a header (or a cookie, or the query). */
const HELPER_FORMS: Array<[string, string, string]> = [
  ["X6 header", "services/d1-1/clients.ts", '\nexport const scopeOf = (request: Request) => request.headers.get("x-scope")\n'],
  ["X6 cookie", "services/d1-2/matters.ts", '\nexport const scopeOf = (request: { cookies: Map<string, string> }) => request.cookies.get("scope")\n'],
  ["X6 next/headers", "platform/persistence/memberSync.ts", '\nimport { headers } from "next/headers"\n'],
  ["X6 query", "services/d2-1/whatsapp.ts", '\nexport const idOf = (url: URL) => url.searchParams.get("id")\n'],
]

describe("G-2 static guard: selectors only through the declared surface", () => {
  it("scans, one import level deep, every local module the G-2 routes import (the platform/http boundary excepted)", () => {
    const helpers = helperModulesOf(GUARDED_ROUTES.map((f) => path.join(ROOT, f)), ROOT)
    expect(helpers).toContain("services/d1-1/clients.ts")
    expect(helpers).toContain("platform/p5/tenancyAdmin.ts")
    expect(helpers.some((h) => h.startsWith("platform/http/"))).toBe(false)
    expect(helpers.flatMap((h) => helperViolations(read(h)).map((v) => `${h}: ${v}`))).toEqual([])
  })

  it.each(HELPER_FORMS)("rejects helper form %s", (_label, file, added) => {
    expect(helperViolations(read(file) + added).length).toBeGreaterThan(0)
  })


  it.each(GUARDED_ROUTES)("%s reads selectors only through its surface", (file) => {
    expect(guardViolations(read(file), { route: true })).toEqual([])
  })

  it.each(GUARDED_HANDLERS)("%s dispatches commands only through WHATSAPP_COMMANDS", (file) => {
    expect(guardViolations(read(file), { route: false })).toEqual([])
  })

  it.each(FORMS)("rejects form %s", (_label, file, mutate) => {
    const src = read(file)
    const mutated = mutate(src)
    expect(mutated).not.toBe(src)
    expect(guardViolations(mutated, { route: file.startsWith("app/") }).length).toBeGreaterThan(0)
  })
})
