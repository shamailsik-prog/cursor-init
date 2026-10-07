import { afterEach, describe, expect, it } from "vitest"
import {
  SurfaceError,
  actionOf,
  bodyFieldsOf,
  defineSurface,
  getQuery,
  isAction,
  refuseUndeclaredBody,
  selectView,
} from "@/platform/http/surface"
import { BodySchema as CLIENTS_BODY, CLIENTS_SURFACE } from "@/app/api/d1/clients/surface"
import { GET as mattersGet } from "@/app/api/d1/matters/route"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as workflowGet } from "@/app/api/d1/document-workflow/route"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
import { GET as tenancyGet } from "@/app/api/p5/tenancy/route"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { bindRequestToSession, withSession } from "@/platform/http/withSession"

afterEach(() => resetRuntimeStoreForTests())

const SURFACE = defineSurface({
  views: ["list", "detail"],
  defaultView: "list",
  actions: ["create"],
  bodyFields: { create: ["action", "actorId", "name"] },
  queryParams: ["view", "limit", "actorId"],
  headers: [],
})

describe("route surface helpers", () => {
  it("getQuery reads a declared key and throws for an undeclared one", () => {
    const url = new URL("http://x/a?limit=5&id=9")
    expect(getQuery(SURFACE, url, "limit")).toBe("5")
    expect(() => getQuery(SURFACE, url, "id")).toThrow(SurfaceError)
  })

  it("selectView: default when absent or empty, the value when declared, undefined when not", () => {
    expect(selectView(SURFACE, new URL("http://x/a"))).toBe("list")
    expect(selectView(SURFACE, new URL("http://x/a?view="))).toBe("list")
    expect(selectView(SURFACE, new URL("http://x/a?view=detail"))).toBe("detail")
    expect(selectView(SURFACE, new URL("http://x/a?view=dump"))).toBeUndefined()
  })

  it("actionOf / isAction: only declared actions; isAction throws for an undeclared literal", () => {
    expect(actionOf(SURFACE, { action: "create" })).toBe("create")
    expect(actionOf(SURFACE, {})).toBeNull()
    expect(actionOf(SURFACE, { action: "dump" })).toBeUndefined()
    expect(isAction(SURFACE, { action: "create" }, "create")).toBe(true)
    expect(() => isAction(SURFACE, { action: "dump" }, "dump")).toThrow(SurfaceError)
  })

  it("refuseUndeclaredBody: 400 unknown_param for a field the action does not declare", async () => {
    expect(refuseUndeclaredBody(SURFACE, { action: "create", actorId: "u", name: "n" })).toBeNull()
    const res = refuseUndeclaredBody(SURFACE, { action: "create", name: "n", entityIds: ["x"] })
    expect(res?.status).toBe(400)
    expect(await res?.json()).toEqual({ error: "unknown body parameter: entityIds", code: "unknown_param" })
  })

  it("defineSurface rejects an inconsistent surface", () => {
    expect(() => defineSurface({ views: [], actions: ["a"], bodyFields: {}, queryParams: [], headers: [] })).toThrow(SurfaceError)
    expect(() => defineSurface({ views: ["x"], defaultView: "y", actions: [], bodyFields: {}, queryParams: ["view"], headers: [] })).toThrow(SurfaceError)
  })

  it("bodyFieldsOf reads the zod schema's fields per action", () => {
    expect(bodyFieldsOf(CLIENTS_BODY)).toEqual(CLIENTS_SURFACE.bodyFields)
    expect(CLIENTS_SURFACE.bodyFields.conflict_check).toEqual(["action", "actorId", "entityId", "firmId"])
  })
})

describe("routes refuse what their surface does not declare", () => {
  it("an undeclared query param → 400 unknown_param", async () => {
    const res = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&id=mat_1"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown query parameter: id", code: "unknown_param" })
  })

  it("an undeclared view is answered as before (the default queue for document-workflow)", async () => {
    const res = await workflowGet(new Request("http://127.0.0.1/api/d1/document-workflow?userId=partner_a&view=dump"))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { view: string }).view).toBe("queue")
  })

  it("an undeclared body field → 400 unknown_param", async () => {
    const res = await clientsPost(
      new Request("http://127.0.0.1/api/d1/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "0b5b7c34-8a0f-4c1f-9d3e-2f6a8c1d4e5f" },
        body: JSON.stringify({ action: "conflict_check", actorId: "partner_a", firmId: "firmA", entityId: "e1", entityIds: ["e2"] }),
      })
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown body parameter: entityIds", code: "unknown_param" })
  })
})

describe("the handler sees only declared headers (fix round 3, R1)", () => {
  const HEADER_SURFACE = defineSurface({
    views: [],
    actions: [],
    bodyFields: {},
    queryParams: ["actorId", "userId", "firmId"],
    headers: ["authorization", "x-firm-id", "idempotency-key", "content-type"],
  })
  const incoming = () =>
    new Request("http://127.0.0.1/api/x?actorId=partner_a", {
      headers: {
        authorization: "Bearer t",
        "x-firm-id": "firmA",
        "idempotency-key": "k",
        "content-type": "application/json",
        cookie: "scope=all",
        "x-view": "all",
        "x-forwarded-for": "10.0.0.1",
      },
    })

  it("withSession (insecure-dev) drops undeclared headers and the cookie", async () => {
    let seen: string[] = []
    const res = await withSession(
      incoming(),
      (request) => {
        seen = [...request.headers.keys()].sort()
        return new Response(null, { status: 204 })
      },
      { surface: HEADER_SURFACE }
    )
    expect(res.status).toBe(204)
    expect(seen).toEqual(["authorization", "content-type", "idempotency-key", "x-firm-id"])
  })

  it("bindRequestToSession (firebase mode) drops them too", async () => {
    const bound = await bindRequestToSession(
      incoming(),
      { userId: "partner_a", firmId: "firmA", role: "partner", clearance: "privileged-restricted", mode: "firebase" },
      { surface: HEADER_SURFACE }
    )
    expect(bound).toBeInstanceOf(Request)
    expect([...(bound as Request).headers.keys()].sort()).toEqual(["authorization", "content-type", "idempotency-key", "x-firm-id"])
  })

  it("without a surface, headers pass through unchanged", async () => {
    let cookie: string | null = null
    await withSession(incoming(), (request) => {
      cookie = request.headers.get("cookie")
      return new Response(null, { status: 204 })
    })
    expect(cookie).toBe("scope=all")
  })
})

describe("an empty view= selects the route's default view (fix round 3, M2)", () => {
  it.each([
    ["/api/p5/tenancy", tenancyGet, "?userId=partner_a&view=", (b: Record<string, unknown>) => (b.session as { user: { id: string } }).user.id, "partner_a"],
    ["/api/d1/reporting", reportingGet, "?actorId=partner_a&view=", (b: Record<string, unknown>) => b.view, "search"],
    ["/api/d1/document-workflow", workflowGet, "?userId=partner_a&view=", (b: Record<string, unknown>) => b.view, "queue"],
  ] as const)("%s", async (route, handler, query, pick, expected) => {
    const res = await handler(new Request(`http://127.0.0.1${route}${query}`))
    expect(res.status).toBe(200)
    expect(pick((await res.json()) as Record<string, unknown>)).toBe(expected)
  })
})
