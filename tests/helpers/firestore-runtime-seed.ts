import { getProductionFirestore } from "@/platform/persistence/adminFirestore"

/** Minimal firmA records so matter routes work against Admin Firestore persistence. */
export async function seedFirmARuntimeRecords(): Promise<void> {
  const db = await getProductionFirestore()
  await db.collection("users").doc("partner_a").set({
    firmId: "firmA",
    role: "partner",
    clearanceLevel: "privileged-restricted",
    active: true,
  })
  await db.collection("users").doc("associate_a").set({
    firmId: "firmA",
    role: "associate",
    clearanceLevel: "privileged",
    active: true,
  })
  await db.collection("clients").doc("client_a").set({
    firmId: "firmA",
    name: "F01 seed client",
    classification: "internal",
    status: "active",
  })
  await db.collection("firms").doc("firmA").set({
    id: "firmA",
    name: "Firm A",
    status: "active",
  })
}
