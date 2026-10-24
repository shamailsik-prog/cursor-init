import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"

export async function probeFirmIsolation(opts: {
  host: string
  port: number
  rulesPath: string
  projectId?: string
}): Promise<void> {
  const projectId = opts.projectId ?? "f33-backup-drill"
  const env: RulesTestEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: { host: opts.host, port: opts.port, rules: await import("node:fs").then((f) => f.readFileSync(opts.rulesPath, "utf8")) },
  })
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await db.collection("firms").doc("firm-alpha").set({ name: "Alpha" })
    await db.collection("firms").doc("firm-bravo").set({ name: "Bravo" })
    await db.collection("users").doc("u-a").set({ firmId: "firm-alpha" })
    await db.collection("clients").doc("c-a").set({ firmId: "firm-alpha", name: "Client A" })
    await db.collection("clients").doc("c-b").set({ firmId: "firm-bravo", name: "Client B" })
  })
  const partner = env.authenticatedContext("u-a", { firmId: "firm-alpha" })
  await partner.firestore().collection("clients").doc("c-a").get()
  try {
    await partner.firestore().collection("clients").doc("c-b").get()
    throw new Error("firm isolation probe: partner read firm B client")
  } catch (err) {
    if ((err as Error).message.includes("firm isolation")) throw err
  }
  await env.cleanup()
}
