import { afterAll, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { NAME_REINDEX_JOB_TYPE } from "../src/d1/conflict/reindexJob"
import { readRegistryState } from "../src/d1/registryVersion"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { ApiError, viaApi } from "./api"
import { deleteFirmData } from "./firmCleanup"
import { FakeClock, readJob, testDeps } from "./jobs"

/**
 * Audit F37 re-audit FA-D1C-002, the real delivery: the registry triggers deployed in the Functions emulator (built
 * from functions/lib) receive the Firestore emulator's events for an out-of-band rename and break the index, and the
 * screen refuses until the reindex job rebuilds it. Measures the window between the out-of-band write and the
 * trigger's break (the residual: a screen inside that window does not see the new name).
 *
 * Runs only with F37_TRIGGER_PIPELINE=1 under `emulators:exec --only auth,firestore,functions` (scratch recipe in
 * the plan's follow-up section); otherwise skipped. On a tree whose Functions have no registry triggers the mirror
 * never breaks and the screen keeps answering CLEAR (the RED).
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")

const PIPELINE = EMULATORS && process.env.F37_TRIGGER_PIPELINE === "1"
const SAMPLES = 5
const WAIT_MS = 20_000

const created = { firms: [] as string[], uids: [] as string[] }
afterAll(async () => {
  if (PIPELINE) await deleteFirmData(created.firms, created.uids)
}, 600_000)

let mobileSeq = 0
const nextMobile = () => `0306${String(8000000 + ++mobileSeq)}`

async function screen(firmId: string, token: string, clientId: string): Promise<string> {
  try {
    const out = await runCheck({ token, data: { firmId, client: { clientId }, opposingParties: [{ name: "Haris Qalbani" }] } } as never)
    return `${out.result}${out.hits.some((h) => h.matchedName === "Haris Qalbani" && h.outcome !== "NONE") ? "+HIT" : ""}`
  } catch (err) {
    if (err instanceof ApiError) return `ERR ${err.status} ${err.code}`
    throw err
  }
}

describe.skipIf(!PIPELINE)("FA-D1C-002 through the Functions emulator: an out-of-band rename breaks the index within the trigger's latency", () => {
  it(`${SAMPLES} renames: the mirror breaks, the screen refuses, the job heals; latencies reported`, async () => {
    const latencies: Array<{ broken: number; refused: number }> = []
    for (let i = 0; i < SAMPLES; i++) {
      const firmId = uniq("f37pipe")
      created.firms.push(firmId)
      await adminDb().collection("firms").doc(firmId).set({ name: "F37 pipeline firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
      const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
      created.uids.push(partner.uid)
      const subject = await registerClient({ token: partner.token, data: { firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
      const target = await registerClient({ token: partner.token, data: { firmId, name: "Zubair Hashmi", type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
      // Let the product writes' own trigger events drain (stamped: they must leave the index current).
      await new Promise((r) => setTimeout(r, 1500))
      const settled = await readRegistryState(firmId)
      expect(settled.nameIndex.version).toBe(settled.version)
      expect(await screen(firmId, partner.token, subject.clientId)).toBe("CLEAR")

      const t0 = Date.now()
      await adminDb().collection("clients").doc(target.clientId).update({ canonicalName: "Haris Qalbani" })
      let broken = -1
      let refused = -1
      while (Date.now() - t0 < WAIT_MS && (broken < 0 || refused < 0)) {
        if (broken < 0) {
          const s = await readRegistryState(firmId)
          if (s.nameIndex.version !== s.version) broken = Date.now() - t0
        }
        if (refused < 0 && (await screen(firmId, partner.token, subject.clientId)) === "ERR 503 screening_unavailable") refused = Date.now() - t0
        await new Promise((r) => setTimeout(r, 20))
      }
      latencies.push({ broken, refused })
      expect(broken).toBeGreaterThanOrEqual(0)
      expect(refused).toBeGreaterThanOrEqual(0)

      const jobs = (await adminDb().collection("jobs").where("firmId", "==", firmId).get()).docs.filter((d) => d.data().jobType === NAME_REINDEX_JOB_TYPE)
      expect(jobs.length).toBeGreaterThanOrEqual(1)
      const job = jobs[0]
      const state = (await readJob(job.id)).status
      if (state !== "done") await runJobTask({ jobId: job.id, seq: (await readJob(job.id)).dispatchSeq }, testDeps(new FakeClock(Date.now() + 60_000)))
      let healed = ""
      const t1 = Date.now()
      while (Date.now() - t1 < WAIT_MS && !healed.endsWith("+HIT")) {
        healed = await screen(firmId, partner.token, subject.clientId)
        if (!healed.endsWith("+HIT")) await new Promise((r) => setTimeout(r, 100))
      }
      expect(healed).toBe("POSSIBLE_CANDIDATE_REVIEW+HIT")
    }
    const sorted = (k: "broken" | "refused") => latencies.map((l) => l[k]).sort((a, b) => a - b)
    console.log(`F37-FU trigger latency ms: broken=${JSON.stringify(sorted("broken"))} refused=${JSON.stringify(sorted("refused"))}`)
  }, 600_000)
})
