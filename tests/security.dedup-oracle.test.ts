// Review round 1, finding 3: the cross-matter label raise on dedup was an existence oracle.
// Ruling (coordinator; erratum E-30): §4.2 content dedup is scoped to (firmId, matterId);
// classification = max(caller label | privileged default, matter floor); other matters are
// never consulted.
import { afterEach, describe, expect, it } from "vitest"
import { GET as DOCS_GET, POST as DOCS } from "@/app/api/d1/documents/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => resetRuntimeStoreForTests())
let n = 0
const key = () => `d0d0d0d0-0000-4000-8000-${String(++n).padStart(12, "0")}`
const ingest = (body: unknown) =>
  DOCS(
    new Request("http://127.0.0.1/api/d1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

describe("dedup is not a cross-matter oracle", () => {
  it("the same bytes held privileged-restricted in another matter do not change the uploader's label", async () => {
    const store = getRuntimeStore()
    const secret = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "secret", courtId: "SHC", classification: "privileged-restricted" })
    addMember(store, secret.id, "partner_a", "firmA")
    const mine = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "mine", courtId: "SHC", classification: "internal" })
    addMember(store, mine.id, "associate_a", "firmA")
    const bytes = Buffer.from("the whistleblower memo").toString("base64")
    const held = await ingest({ action: "ingest", actorId: "partner_a", firmId: "firmA", matterId: secret.id, contentBase64: bytes, sourceChannel: "web", classification: "privileged-restricted" })
    expect(held.status).toBe(200)
    const heldId = ((await held.json()) as { result: { doc: { id: string } } }).result.doc.id

    const probe = await ingest({ action: "ingest", actorId: "associate_a", firmId: "firmA", matterId: mine.id, contentBase64: bytes, sourceChannel: "web", classification: "internal" })
    const control = await ingest({ action: "ingest", actorId: "associate_a", firmId: "firmA", matterId: mine.id, contentBase64: Buffer.from("random other").toString("base64"), sourceChannel: "web", classification: "internal" })
    const pj = (await probe.json()) as { result: { reused: boolean; doc: { id: string; classification: string } } }
    const cj = (await control.json()) as { result: { reused: boolean; doc: { id: string; classification: string } } }
    // Indistinguishable from the control: same label, new document, not reused.
    expect(pj.result.doc.classification).toBe("internal")
    expect(cj.result.doc.classification).toBe("internal")
    expect(pj.result.reused).toBe(cj.result.reused)
    expect(pj.result.doc.id).not.toBe(heldId)
    // The uploader can see their own upload; the held record is untouched.
    const list = await DOCS_GET(new Request(`http://127.0.0.1/api/d1/documents?userId=associate_a&matterId=${mine.id}`))
    const lj = (await list.json()) as { items: Array<{ id: string }> }
    expect(lj.items.map((d) => d.id)).toContain(pj.result.doc.id)
    expect(store.documents.get(heldId)?.classification).toBe("privileged-restricted")
    expect(store.documents.get(heldId)?.matterId).toBe(secret.id)
  })

  it("an unlabelled upload is max(privileged, matter floor) regardless of copies elsewhere", async () => {
    const store = getRuntimeStore()
    const other = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "o", courtId: "SHC", classification: "privileged-restricted" })
    addMember(store, other.id, "partner_a", "firmA")
    const mine = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "m", courtId: "SHC", classification: "internal" })
    addMember(store, mine.id, "partner_a", "firmA")
    const bytes = Buffer.from("same bytes").toString("base64")
    await ingest({ action: "ingest", actorId: "partner_a", firmId: "firmA", matterId: other.id, contentBase64: bytes, sourceChannel: "web", classification: "privileged-restricted" })
    const res = await ingest({ action: "ingest", actorId: "partner_a", firmId: "firmA", matterId: mine.id, contentBase64: bytes, sourceChannel: "web" })
    const json = (await res.json()) as { result: { doc: { classification: string } } }
    expect(json.result.doc.classification).toBe("privileged")
  })
})
