import { addMember, createMatter } from "@/services/d1-2/matters"
import { createClient } from "@/services/d1-1/clients"
import { seedUser } from "@/platform/p5/checkPermission"
import {
  seedJudgment,
  seedSection,
  seedTreatment,
} from "@/services/d4-2/draftingIntelligence"
import { newStore, type SpineStore } from "@/platform/spine/store"

export const DEMO = {
  firmId: "nhs-legal",
  partnerId: "user_shamail",
  clerkId: "user_clerk",
  clientId: "user_client",
} as const

export function seedNhsLegal(store: SpineStore): SpineStore {
  seedUser(store, {
    id: DEMO.partnerId,
    firmId: DEMO.firmId,
    role: "partner",
    clearanceLevel: "privileged-restricted",
  })
  seedUser(store, {
    id: DEMO.clerkId,
    firmId: DEMO.firmId,
    role: "clerk",
    clearanceLevel: "confidential",
  })
  seedUser(store, {
    id: DEMO.clientId,
    firmId: DEMO.firmId,
    role: "client",
    clearanceLevel: "internal",
  })

  createClient(store, {
    firmId: DEMO.firmId,
    canonicalName: "Muhammad Ali",
    cnic: "4210112345671",
    phone: "03001111111",
  })

  const m1 = createMatter(store, {
    firmId: DEMO.firmId,
    clientId: DEMO.clientId,
    title: "C.P. D-1234/2025 — NHS v. Provincial Government",
    courtId: "SHC",
    classification: "confidential",
  })
  const m2 = createMatter(store, {
    firmId: DEMO.firmId,
    clientId: "other-client",
    title: "Bail — s.497 CrPC (client file pending engagement)",
    courtId: "SHC",
    classification: "privileged",
  })
  addMember(store, m1.id, DEMO.clerkId, DEMO.firmId)
  addMember(store, m1.id, DEMO.partnerId, DEMO.firmId)
  addMember(store, m1.id, DEMO.clientId, DEMO.firmId)
  addMember(store, m2.id, DEMO.clerkId, DEMO.firmId)
  addMember(store, m2.id, DEMO.partnerId, DEMO.firmId)

  seedJudgment(store, "j-old", "Cited single-bench authority", "single")
  seedJudgment(store, "j-later", "Larger-bench overruling", "larger")
  seedTreatment(store, "j-later", "j-old", "overruled", "larger")
  seedSection(store, "ppc_302", [
    {
      versionNo: 1,
      effectiveFrom: "1860-10-06",
      effectiveTo: "2018-01-01",
      text: "PPC 302 text as in 2015",
    },
    {
      versionNo: 2,
      effectiveFrom: "2018-01-01",
      effectiveTo: null,
      text: "PPC 302 text as amended 2018",
    },
  ])
  store.embeddings.push({
    entityId: "j-old",
    model: "text-embedding-3-small",
    vector: new Array(8).fill(0),
  })
  return store
}

export function freshSeededStore(): SpineStore {
  return seedNhsLegal(newStore())
}
