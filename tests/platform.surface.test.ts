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
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

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
