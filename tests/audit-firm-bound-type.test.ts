import { describe, it } from "vitest"
import type { FirmBoundSpineRepositories } from "@/platform/persistence/firmBoundRepositories"

type MatterGet = FirmBoundSpineRepositories["matters"]["get"]
type DraftGet = FirmBoundSpineRepositories["drafts"]["get"]
type MembersList = FirmBoundSpineRepositories["members"]["listByFirm"]

describe("FirmBoundSpineRepositories arity", () => {
  it("narrows get/update/listByFirm signatures", () => {
    expectType<[id: string]>(null as unknown as Parameters<MatterGet>)
    expectType<[id: string]>(null as unknown as Parameters<DraftGet>)
    expectType<[firmId?: string]>(null as unknown as Parameters<MembersList>)
  })
})

function expectType<T>(_value: T): void {
  /* compile-time only */
}
