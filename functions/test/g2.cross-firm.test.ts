import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs, query, setDoc, setLogLevel, where } from "firebase/firestore"
import { adminAuth, adminDb } from "../src/admin"
import * as index from "../src/index"
import * as identity from "../src/p5/identity"
import * as mfa from "../src/p5/mfa"
import * as gates from "../src/p5/gates"
import * as numbering from "../src/d1/client/numberingOp"
import * as clientOps from "../src/d1/client/ops"
import * as conflictOps from "../src/d1/conflict/ops"
import * as matterOps from "../src/d1/matter/ops"
import * as entityRead from "../src/d1/entity/read"
import * as entityOps from "../src/d1/entity/ops"
import * as entityUnmerge from "../src/d1/entity/unmerge"
import * as jobOps from "../src/p2/ops"
import * as p1Ops from "../src/p1/ops"
import * as draftOps from "../src/d4/drafts"
import * as doctypeOps from "../src/d4/doctypeOps"
import * as gateOps from "../src/d4/gateOps"
import { enqueueJob } from "../src/p2/enqueue"
import { ROUTES, createRouter } from "../src/http/router"
import type { Operation } from "../src/p5/common"
import { EMULATORS, mintIdToken, mockRes, uniq } from "./emu"

/**
 * Gate G-2 (L18 §10, functions side): two firms are seeded; every HTTP `api`
 * route (the only entry point to the P5 operations — U-1, no callables are
 * deployed) is attempted by each firm-B role against firm A (X-Firm-Id of
 * firm A, or a firm-A user as the target), and every tenant collection in
 * firestore.rules is read cross-firm. All must deny, leak no firm-A data, and
 * leave firm A unchanged.
 *
 * The lists are derived, not hand-copied: the routes are ROUTES, the deployed
 * entries are src/index.ts's exports, the collections are the `match` blocks
 * of firestore.rules. A new route, export or collection without a probe fails
 * this suite. `G2_COVERAGE_OUT` (set by ci_gates/gate_g2.sh) receives the
 * coverage rows as JSON.
 */

const ROLES = ["partner", "associate", "clerk", "intern", "accounts", "client"] as const
type Role = (typeof ROLES)[number]
const MAX_CLEARANCE = "privileged-restricted"

type Row = { suite: string; service: string; channel: string; path: string; status: string; attempts: number; allowed: number; note?: string }
const rows: Row[] = []

afterAll(() => {
  const out = process.env.G2_COVERAGE_OUT
  if (out) writeFileSync(out, JSON.stringify({ suite: "functions", rows }, null, 2))
})

/** Non-endpoint exports of src/index.ts (deploy entries that are not identity reads). */
const NOT_TENANT_ENDPOINTS: Record<string, string> = {
  health: "health probe, no tenant data",
  api: "HTTP router, probed route by route",
  onJobCreated: "Firestore trigger on jobs, no caller",
  onEventCreated: "Firestore trigger on events, no caller",
  jobWorker: "Cloud Tasks queue function, OIDC-invoked by Cloud Tasks only; acts on the job id it is given",
  jobSweeper: "scheduler, no caller",
  d1AutoConfirmTick: "scheduler, no caller; enqueues d1.autoconfirm for every firm, which acts only on its own firm"
}

/**
 * Every operation (HTTP route), how to aim it at firm A. `target`: the op names a user (the
 * firm-A victim is put in the payload); otherwise only the firm binding can be
 * aimed at firm A. `firmless`: the op takes no firm (onboarding, platform).
 */
type Probe = { data: (a: FirmA) => Record<string, unknown>; target: boolean; firmless?: boolean }
const PROBES: Record<string, Probe> = {
  onboardFirm: { data: () => ({ name: "G2 probe firm" }), target: false, firmless: true },
  recordGatePass: { data: () => ({ gate: "G-2", evidence: { summary: "forged by a firm user", commitSha: "6e66bf1", runUrl: "https://example.test/run/1", counts: { tested: 1, notBuilt: 0, outOfScope: 0, global: 0, allowed: 0 } } }), target: false, firmless: true },
  createFirmUser: { data: () => ({ email: `${uniq("g2probe")}@example.test`, role: "clerk", clearanceLevel: "internal" }), target: false },
  setUserClaims: { data: (a) => ({ uid: a.victim, role: "clerk" }), target: true },
  deactivateUser: { data: (a) => ({ uid: a.victim }), target: true },
  enforceMfaForRole: { data: () => ({ role: "associate", enforced: true }), target: false },
  approveMfaDisable: { data: (a) => ({ uid: a.victim }), target: true },
  disableMfa: { data: (a) => ({ uid: a.victim, approvalId: a.approvalId, recoveryCode: "AAAA-BBBB-CCCC" }), target: true },
  generateRecoveryCodes: { data: () => ({}), target: false },
  syncMfaStatus: { data: () => ({}), target: false },
  setFirmNumbering: { data: () => ({ clientPrefix: "XX", matterPrefix: "XX" }), target: false },
  registerClient: { data: () => ({ name: "G2 Probe Client", type: "individual", primaryMobile: "03001234567", classification: "internal" }), target: false },
  getClient: { data: (a) => ({ clientId: a.clientId }), target: true },
  listClients: { data: () => ({}), target: false },
  runConflictCheck: { data: () => ({ client: { name: "G2 Probe Client" }, opposingParties: [{ name: "G2 Probe Opponent" }] }), target: false },
  getConflictResult: { data: (a) => ({ checkId: a.checkId }), target: true },
  resolveReviewItem: { data: () => ({ checkId: "g2-probe-check", hitIndex: 0, resolution: "different_person", note: "G2 probe note of at least twenty characters" }), target: false },
  recordPartnerWaiver: { data: () => ({ checkId: "g2-probe-check", note: "G2 probe waiver note that is comfortably longer than fifty characters", clientConsent: true, consentReference: "G2-REF" }), target: false },
  getConflictTrail: { data: (a) => ({ checkId: a.checkId }), target: true },
  openMatter: { data: () => ({ conflictCheckId: "g2-probe-check", title: "G2 probe matter", classification: "internal" }), target: false },
  getMatter: { data: (a) => ({ matterId: a.matterId }), target: true },
  listMatters: { data: () => ({}), target: false },
  advanceStage: { data: () => ({ matterId: "g2-probe-matter", to: "filed" }), target: false },
  closeMatter: { data: () => ({ matterId: "g2-probe-matter", reason: "G2 probe closure reason, long enough" }), target: false },
  listReviewQueue: { data: () => ({}), target: false },
  getEntity: { data: (a) => ({ entityId: a.entityId }), target: true },
  listAliases: { data: (a) => ({ entityId: a.entityId }), target: true },
  confirmMerge: { data: (a) => ({ linkId: a.linkId, note: "G2 probe decision note, long enough" }), target: true },
  disputeLink: { data: (a) => ({ linkId: a.linkId, note: "G2 probe decision note, long enough" }), target: true },
  unmergeEntity: { data: (a) => ({ linkId: a.linkId, note: "G2 probe decision note, long enough" }), target: true },
  rejectLink: { data: (a) => ({ linkId: a.linkId, note: "G2 probe decision note, long enough" }), target: true },
  listJobs: { data: (a) => ({ matterId: a.matterId }), target: true },
  getJob: { data: (a) => ({ jobId: a.deadJobId }), target: true },
  retryFailedJob: { data: (a) => ({ jobId: a.deadJobId, note: "G2 probe requeue note, long enough" }), target: true },
  cancelJob: { data: (a) => ({ jobId: a.queuedJobId, note: "G2 probe cancel note, long enough" }), target: true },
  // P3-60, P3-70..P3-72: the five P1 routes. committeeBrain names firm A's matter; the rest take no target. The platform
  // kill switch is firmless (platformAdmin claim), like recordGatePass: no firm-B role holds the claim.
  committeeBrain: { data: (a) => ({ matterId: a.matterId, body: "G2 probe: draft a reply to the notice." }), target: true },
  getAiUsage: { data: () => ({ month: "2026-10" }), target: false },
  setBudgetAlerts: { data: () => ({ monthlyBudgetUsd: 999, pkrPerUsd: 1 }), target: false },
  setAiKillSwitch: { data: () => ({ disableAll: true, disabledModels: [], reason: "G2 probe stop" }), target: false },
  setPlatformAiKillSwitch: { data: () => ({ disableAll: true, disabledModels: [], reason: "G2 probe stop" }), target: false, firmless: true },
  // P4-10: the D4 routes. The draft routes name firm A's draft or matter; the document-type reads take no target (a global catalogue).
  createDraft: { data: (a) => ({ matterId: a.matterId, documentTypeId: "constitutional_petition_199", title: "G2 probe draft", body: "G2 probe body." }), target: true },
  saveDraftVersion: { data: (a) => ({ draftId: a.draftId, baseVersion: 1, title: "G2 probe title", body: "G2 probe body." }), target: true },
  restoreDraftVersion: { data: (a) => ({ draftId: a.draftId, baseVersion: 1, fromVersion: 1 }), target: true },
  getDraft: { data: (a) => ({ draftId: a.draftId }), target: true },
  listDrafts: { data: (a) => ({ matterId: a.matterId }), target: true },
  listDraftVersions: { data: (a) => ({ draftId: a.draftId }), target: true },
  listDocumentTypes: { data: () => ({}), target: false },
  getTypeProfile: { data: () => ({ typeId: "constitutional_petition_199" }), target: false },
  // P4-6..P4-8: the gate, the report, the override and the approval, aimed at firm A's gated draft.
  gateDraft: { data: (a) => ({ draftId: a.draftId, version: 1 }), target: true },
  getVerificationReport: { data: (a) => ({ draftId: a.draftId }), target: true },
  overrideGate: { data: (a) => ({ draftId: a.draftId, version: 1, reason: "G2 probe override reason, long enough to pass" }), target: true },
  approveDraft: { data: (a) => ({ draftId: a.draftId, version: 1 }), target: true },
}

const HANDLER_MODULES = [identity, mfa, gates, numbering, clientOps, conflictOps, matterOps, entityRead, entityOps, entityUnmerge, jobOps, p1Ops, draftOps, doctypeOps, gateOps] as unknown as Record<string, unknown>[]
function opFor(name: string): Operation | undefined {
  for (const mod of HANDLER_MODULES) {
    const op = mod[`${name}Op`] as Operation | undefined
    if (op && typeof op === "object" && "run" in op) return op
  }
  return undefined
}

/** Deployed exports other than the HTTP router, the health probe and the job runtime (must be none: U-1). */
const OTHER_EXPORTS = Object.keys(index)
  .filter((n) => !(n in NOT_TENANT_ENDPOINTS))
  .sort()

type Member = { uid: string; token: string; email: string }
type FirmA = { firmId: string; partner: Member; victim: string; victimEmail: string; approvalId: string; users: string[]; clientId: string; matterId: string; checkId: string; entityId: string; linkId: string; deadJobId: string; queuedJobId: string; draftId: string }
type FirmB = { firmId: string; members: Record<Role, Member> }

async function seedFirm(firmId: string, name: string): Promise<Record<Role, Member>> {
  await adminDb().collection("firms").doc(firmId).set({ name, dataResidency: "PK", plan: "internal" })
  const members = {} as Record<Role, Member>
  for (const role of ROLES) {
    members[role] = await mintIdToken({ firmId, role, clearanceLevel: MAX_CLEARANCE }, { emailVerified: true })
  }
  return members
}

/** Firm A's observable state: users docs, Auth claims/disabled, firm doc, the approval, recovery docs. */
async function snapshotFirmA(a: FirmA): Promise<unknown> {
  const users = await Promise.all(
    a.users.map(async (uid) => {
      const d = (await adminDb().collection("users").doc(uid).get()).data() ?? {}
      const au = await adminAuth().getUser(uid)
      return {
        uid,
        doc: { role: d.role, clearanceLevel: d.clearanceLevel, active: d.active, mfaEnabled: d.mfaEnabled, claimsVersion: d.claimsVersion },
        claims: au.customClaims,
        disabled: au.disabled,
        factors: au.multiFactor?.enrolledFactors.length ?? 0,
        recovery: (await adminDb().collection("mfa_recovery").doc(uid).get()).exists,
      }
    })
  )
  const firm = (await adminDb().collection("firms").doc(a.firmId).get()).data()
  const approval = (await adminDb().collection("mfa_disable_approvals").doc(a.approvalId).get()).data()
  const firmUsers = (await adminDb().collection("users").where("firmId", "==", a.firmId).count().get()).data().count
  // L17.2: a cross-firm decision that wrote anything (link state, a dispute flag or note, a merge_events row) fails "unchanged".
  const link = (await adminDb().collection("entity_links").doc(a.linkId).get()).data()
  const mergeEvents = (await adminDb().collection("merge_events").where("firmId", "==", a.firmId).count().get()).data().count
  // P3-12, P3-13: a cross-firm requeue or cancel that wrote anything fails "unchanged".
  const jobs = await Promise.all(
    [a.deadJobId, a.queuedJobId].map(async (id) => {
      const j = (await adminDb().collection("jobs").doc(id).get()).data() ?? {}
      return {
        id,
        status: j.status,
        manualRetries: j.manualRetries,
        dispatchSeq: j.dispatchSeq,
        cancellation: j.cancellation,
        updatedAt: j.updatedAt?.toMillis?.(),
        logs: j.logs,
        requeues: j.requeues,
      }
    })
  )
  // P3-60..P3-72: a cross-firm budget, kill switch or AI call that wrote anything fails "unchanged".
  const aiConfig = (await adminDb().collection("ai_config").doc(a.firmId).get()).data()
  const aiOutputs = (await adminDb().collection("committee_outputs").where("firmId", "==", a.firmId).count().get()).data().count
  const aiUsageRows = (await adminDb().collection("ai_usage_logs").where("firmId", "==", a.firmId).count().get()).data().count
  const aiPlatform = (await adminDb().collection("platform").doc("p1").get()).data()
  // P4-4, P4-12: a cross-firm draft save, restore or create that wrote anything (a draft, a version, an event) fails "unchanged".
  const draft = (await adminDb().collection("drafts").doc(a.draftId).get()).data()
  const draftRows = (await adminDb().collection("drafts").where("firmId", "==", a.firmId).count().get()).data().count
  const draftVersionRows = (await adminDb().collection("draft_versions").where("firmId", "==", a.firmId).count().get()).data().count
  const draftEventRows = (await adminDb().collection("events").where("firmId", "==", a.firmId).count().get()).data().count
  // P4-6..P4-8: a cross-firm gate, override or approval that wrote anything (a result, an override, the summary, the lock) fails "unchanged".
  const gateResult = (await adminDb().collection("draft_gate_results").doc(`${a.draftId}_1`).get()).data()
  const gateResultRows = (await adminDb().collection("draft_gate_results").where("firmId", "==", a.firmId).count().get()).data().count
  const gateOverrideRows = (await adminDb().collection("draft_gate_overrides").where("firmId", "==", a.firmId).count().get()).data().count
  return { users, firm: { ...firm }, approval: { used: approval?.used, codeAttempts: approval?.codeAttempts ?? 0 }, firmUsers, link: { ...link }, mergeEvents, jobs, ai: { config: aiConfig, outputs: aiOutputs, usageRows: aiUsageRows, platform: aiPlatform }, drafts: { draft: { ...draft }, draftRows, draftVersionRows, draftEventRows, gateResult: { ...gateResult }, gateResultRows, gateOverrideRows } }
}

/** Every identifier and name of firm A that must never appear in a firm-B response. */
function firmATokens(a: FirmA): string[] {
  return [a.firmId, a.victim, a.victimEmail, a.approvalId, a.partner.uid, a.partner.email, ...a.users, a.clientId, a.matterId, a.checkId, a.entityId, a.linkId, a.deadJobId, a.queuedJobId, a.draftId, "G2 Alpha Draft Title", "G2 ALPHA DRAFT BODY", "G2 ALPHA USED TEXT", "G2 Alpha Chambers", "G2 Alpha Client", "G2 Alpha Matter", "ALPHA-0001", "G2 Alpha Entity"]
}

function leaked(body: unknown, tokens: string[]): string[] {
  const text = JSON.stringify(body ?? null)
  return tokens.filter((t) => text.includes(t))
}

describe.skipIf(!EMULATORS)("G-2 cross-firm isolation: the P5 HTTP api", () => {
  let A: FirmA
  let B: FirmB
  let before: unknown

  beforeAll(async () => {
    const firmA = uniq("g2-firm-a")
    const aMembers = await seedFirm(firmA, "G2 Alpha Chambers")
    // The victim sits below every firm-B caller's clearance, so only the firm boundary can refuse.
    const victim = await mintIdToken({ firmId: firmA, role: "associate", clearanceLevel: "internal" }, { emailVerified: true })
    const approval = adminDb().collection("mfa_disable_approvals").doc()
    await approval.set({
      firmId: firmA,
      subjectUid: victim.uid,
      approverUid: aMembers.partner.uid,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
      used: false,
    })
    // Real firm-A records, so the GET probes aim at data that exists (a same-firm read would find it).
    const clientId = uniq("g2clientA")
    const matterId = uniq("g2matterA")
    const checkId = uniq("g2checkA")
    const stamp = { firmId: firmA, classification: "internal", createdAt: Timestamp.now() }
    await adminDb().collection("clients").doc(clientId).set({ ...stamp, name: "G2 Alpha Client", clientCode: "ALPHA-0001" })
    await adminDb().collection("matters").doc(matterId).set({ ...stamp, title: "G2 Alpha Matter", clientId, stage: "intake", status: "open" })
    await adminDb().collection("matter_members").doc(`${matterId}_${aMembers.partner.uid}`).set({ ...stamp, matterId, userId: aMembers.partner.uid })
    await adminDb().collection("conflict_checks").doc(checkId).set({ ...stamp, status: "CLEAR", subjects: [{ role: "client", name: "G2 Alpha Client" }] })
    // P3-64: firm A holds a budget and a rate, so a cross-firm budget write or AI call would have something to change or spend.
    await adminDb().collection("ai_config").doc(firmA).set({ monthlyBudgetMicroUsd: 1_000_000_000, pkrPerUsd: 280 })
    // L17.2 (Phase 2b-A): two firm-A entities and the candidate link between them, aimed at by the entity probes.
    const entityId = uniq("g2entityA")
    const entityId2 = uniq("g2entityB")
    const linkId = `${firmA}_${entityId}_${entityId2}_cnic`
    await adminDb().collection("entities").doc(entityId).set({ ...stamp, canonicalName: "G2 Alpha Entity", cnic: "4210199999991" })
    await adminDb().collection("entities").doc(entityId2).set({ ...stamp, canonicalName: "G2 Alpha Entity Two", cnic: "4210199999991" })
    await adminDb()
      .collection("entity_links")
      .doc(linkId)
      .set({ firmId: firmA, leftId: entityId, rightId: entityId2, key: "cnic", state: "candidate", disputed: false, classification: "internal", createdAt: Timestamp.now() })
    // P3-10..P3-13: two firm-A diagnostic jobs on the matter, the first dead-lettered (retry probe), the second queued (cancel probe).
    const jobSpec = { firmId: firmA, jobType: "platform.diagnostic", classification: "internal" as const, matterId, payload: { behaviour: "succeed" }, createdBy: aMembers.partner.uid }
    const enqueueOne = () => adminDb().runTransaction((tx) => enqueueJob(tx, { ...jobSpec, idempotencyKey: uniq("g2job") }, { now: Date.now() }))
    const deadJobId = (await enqueueOne()).jobId
    const queuedJobId = (await enqueueOne()).jobId
    await adminDb().collection("jobs").doc(deadJobId).update({ status: "dead_lettered", lastError: { code: "diag_failure", message: "Diagnostic failure (planned)." }, nextAttemptAt: null })
    // P4-4: a firm-A draft with its version 1, written as createDraft writes them, for the draft probes to aim at.
    const draftId = uniq("g2draftA")
    const bodyA = "G2 ALPHA DRAFT BODY"
    const bodySha = createHash("sha256").update(bodyA, "utf8").digest("hex")
    await adminDb().collection("drafts").doc(draftId).set({
      ...stamp,
      matterId,
      documentTypeId: "constitutional_petition_199",
      title: "G2 Alpha Draft Title",
      status: "draft",
      currentVersion: 1,
      currentBodySha256: bodySha,
      locked: false,
      masterVersion: null,
      // P4-6: version 1 is gated (a temporal check with no history), so the override and approval probes aim at a real result.
      gateResult: { version: 1, bodySha256: bodySha, status: "TEMPORAL_UNAVAILABLE", gatedAt: Timestamp.now(), overridden: false },
      lastGatedVersion: 1,
      createdBy: aMembers.partner.uid,
      updatedAt: Timestamp.now(),
    })
    await adminDb().collection("draft_versions").doc(`${draftId}_1`).set({
      ...stamp,
      matterId,
      draftId,
      version: 1,
      title: "G2 Alpha Draft Title",
      body: bodyA,
      bodySha256: bodySha,
      kind: "create",
      createdBy: aMembers.partner.uid,
    })
    await adminDb()
      .collection("draft_gate_results")
      .doc(`${draftId}_1`)
      .set({
        ...stamp,
        matterId,
        draftId,
        version: 1,
        bodySha256: bodySha,
        status: "TEMPORAL_UNAVAILABLE",
        citations: [],
        temporal: [{ sectionId: "test_act_s1", asAtDate: "2015-03-01", jurisdiction: "PK", usedText: "G2 ALPHA USED TEXT", status: "TEMPORAL_UNAVAILABLE", inForceText: null }],
        gatedBy: aMembers.partner.uid,
        gatedAt: Timestamp.now(),
        gateRuns: 1,
      })
    A = {
      firmId: firmA,
      draftId,
      clientId,
      matterId,
      checkId,
      entityId,
      linkId,
      deadJobId,
      queuedJobId,
      partner: aMembers.partner,
      victim: victim.uid,
      victimEmail: victim.email,
      approvalId: approval.id,
      users: [...Object.values(aMembers).map((m) => m.uid), victim.uid],
    }
    const firmB = uniq("g2-firm-b")
    B = { firmId: firmB, members: await seedFirm(firmB, "G2 Beta Associates") }
    before = await snapshotFirmA(A)
  })

  it("only the HTTP api, the health probe and the job runtime functions are deployed; every route has a cross-firm probe and runs its operation", () => {
    expect(OTHER_EXPORTS).toEqual([])
    expect(ROUTES.map((route) => route.path.split("/").pop()!).sort()).toEqual(Object.keys(PROBES).sort())
    for (const route of ROUTES) {
      const name = route.path.split("/").pop()!
      expect([route.path, opFor(name) === route.handler]).toEqual([route.path, true])
    }
  })

  it("HTTP api: each firm-B role on each route with X-Firm-Id=A, or with a firm-A target, is denied, leaks nothing", async () => {
    const tokens = firmATokens(A)
    const router = createRouter(ROUTES)
    const failures: string[] = []
    for (const route of ROUTES) {
      const name = route.path.split("/").pop()!
      const probe = PROBES[name]
      let attempts = 0
      let allowed = 0
      for (const [i, role] of ROLES.entries()) {
        const caller = B.members[role]
        const variants: Array<[string, string]> = [["X-Firm-Id=A", A.firmId]]
        if (probe.target) variants.push(["X-Firm-Id=B, firm-A target", B.firmId])
        for (const [label, firmHeader] of variants) {
          attempts++
          const body = probe.data(A)
          const { res, out } = mockRes()
          await router(
            {
              method: route.method,
              path: route.path,
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${caller.token}`,
                "x-firm-id": firmHeader,
                "idempotency-key": randomUUID(),
                // One client IP per role: auth refusals count against the per-IP limit.
                "x-forwarded-for": `10.0.0.1, 10.62.${i}.${attempts}`,
              },
              body,
              // GET data is the query string (router.ts queryData): without it a GET probe is a bare 400.
              query: route.method === "GET" ? body : undefined,
              rawBody: Buffer.from(JSON.stringify(body)),
              ip: "127.0.0.1",
            } as never,
            res as never
          )
          if (out.status < 400 || out.status >= 500) {
            if (out.status < 400) allowed++
            failures.push(`${route.path} ${role} ${label}: status ${out.status} ${JSON.stringify(out.body)}`)
          }
          const leak = leaked(out.body, tokens)
          if (leak.length) failures.push(`${route.path} ${role} ${label}: leaked ${leak.join(",")}`)
        }
      }
      rows.push({ suite: "functions", service: "P5", channel: "http", path: `${route.method} ${route.path}`, status: "tested", attempts, allowed })
    }
    expect(failures).toEqual([])
  })

  it("positive control: firm A's own partner reads each seeded record through the same GET routes (validates the seed shapes)", async () => {
    const router = createRouter(ROUTES)
    const reads: Array<[string, Record<string, string>, string]> = [
      ["/api/d1/client/getClient", { clientId: A.clientId }, "G2 Alpha Client"],
      ["/api/d1/conflict/getConflictResult", { checkId: A.checkId }, A.checkId],
      ["/api/d1/conflict/getConflictTrail", { checkId: A.checkId }, "items"],
      ["/api/d1/matter/getMatter", { matterId: A.matterId }, "G2 Alpha Matter"],
      ["/api/d1/entity/listReviewQueue", {}, A.linkId],
      ["/api/d1/entity/getEntity", { entityId: A.entityId }, "G2 Alpha Entity"],
      ["/api/d1/entity/listAliases", { entityId: A.entityId }, "G2 Alpha Entity"],
      ["/api/platform/jobs/getJob", { jobId: A.deadJobId }, A.deadJobId],
      ["/api/platform/jobs/listJobs", { matterId: A.matterId }, A.deadJobId],
      ["/api/platform/brain/getAiUsage", { month: "2026-10" }, "killSwitch"],
      ["/api/d4/drafting/getDraft", { draftId: A.draftId }, "G2 ALPHA DRAFT BODY"],
      ["/api/d4/drafting/listDrafts", { matterId: A.matterId }, "G2 Alpha Draft Title"],
      ["/api/d4/drafting/listDraftVersions", { draftId: A.draftId }, "bodySha256"],
      ["/api/d4/intelligence/listDocumentTypes", { q: "Art. 199" }, "constitutional_petition_199"],
      ["/api/d4/intelligence/getTypeProfile", { typeId: "constitutional_petition_199" }, "template_cp_199_v1"],
      ["/api/d4/intelligence/getVerificationReport", { draftId: A.draftId }, "G2 ALPHA USED TEXT"],
    ]
    for (const [i, [path, query, token]] of reads.entries()) {
      const { res, out } = mockRes()
      await router(
        {
          method: "GET",
          path,
          headers: { authorization: `Bearer ${A.partner.token}`, "x-firm-id": A.firmId, "x-forwarded-for": `10.9.0.${i + 1}` },
          body: undefined,
          query,
          rawBody: Buffer.from(""),
          ip: "127.0.0.1",
        } as never,
        res as never
      )
      expect([path, out.status, JSON.stringify(out.body).includes(token)]).toEqual([path, 200, true])
    }
  })

  it("firm A is unchanged, and no firm-B actor holds an allow audit row on firm A", async () => {
    expect(await snapshotFirmA(A)).toEqual(before)
    const bUids = new Set(Object.values(B.members).map((m) => m.uid))
    const allowRows = (await adminDb().collection("audit_log").where("decision", "==", "allow").get()).docs
      .map((d) => d.data())
      .filter((r) => bUids.has(r.actorId as string))
      .filter((r) => r.firmId === A.firmId || A.users.some((uid) => String(r.target).includes(uid)))
    expect(allowRows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Firestore rules: every tenant collection read cross-firm.
// ---------------------------------------------------------------------------

const RULES_PATH = path.resolve(__dirname, "../../firestore.rules")
const RULES = readFileSync(RULES_PATH, "utf8")

/** `match /<collection>/{<id>} { ... }` blocks of firestore.rules (not the `/databases/{database}/documents` root, not the catch-all). */
function ruleCollections(rules: string): Array<{ name: string; block: string }> {
  const re = /match \/([A-Za-z0-9_]+)\/\{\w+\}(?!\/)/g
  const starts = [...rules.matchAll(re)]
  return starts.map((m, i) => ({
    name: m[1],
    block: rules.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : rules.length),
  }))
}

/**
 * A server-only collection: every `allow` in its block is `if false` (fix/sec-gaps: the
 * escalation-closure collections and audit_dead_letter). No client of any firm reads or writes
 * it; it holds tenant rows, so it is swept like every tenant collection (firm-B denial) and its
 * control asserts that even firm A's own partner is denied.
 */
function isServerOnly(block: string): boolean {
  const conditions = [...block.matchAll(/allow [a-z, ]+:\s*if ([^;]+);/g)].map((m) => m[1].trim())
  return conditions.length > 0 && conditions.every((c) => c === "false")
}

/** A collection whose read rule never consults the caller's firm (and is not server-only) is platform-global (not tenant data). */
function isGlobal(block: string): boolean {
  return !isServerOnly(block) && !/sameFirm\(\)|tok\(\)\.firmId/.test(block)
}

const COLLECTIONS = ruleCollections(RULES)
/** Platform-global collections, reviewed: feature flags carry no tenant data. Anything new here fails the gate. */
const REVIEWED_GLOBAL = ["feature_flags"]

function emulatorHostPort(): { host: string; port: number } {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":")
  return { host, port: Number(port) }
}

describe.skipIf(!EMULATORS)("G-2 cross-firm isolation: Firestore rules, every tenant collection", () => {
  const FIRM_A = "g2-rules-firm-a"
  const FIRM_B = "g2-rules-firm-b"
  const MATTER_A = "g2-matter-a"
  const A_PARTNER = "g2-a-partner"
  const bUid = (role: Role) => `g2-b-${role}`
  let env: RulesTestEnvironment

  const docIdFor = (name: string) => (name === "firms" ? FIRM_A : name === "matters" ? MATTER_A : "g2-a-doc")
  const seedFor = (name: string) => ({
    firmId: FIRM_A,
    classification: "public",
    matterId: MATTER_A,
    userId: A_PARTNER,
    name: "G2-ALPHA-SECRET",
    // matter_client_search_index reads membership of the row's matter (fix/sec-gaps R1 #6):
    // a matter row names it in referenceId.
    ...(name === "matter_client_search_index" ? { rowType: "matter", referenceId: MATTER_A } : {}),
  })

  beforeAll(async () => {
    // The client SDK logs every expected PERMISSION_DENIED write stream error; the assertions carry the result.
    setLogLevel("silent")
    env = await initializeTestEnvironment({ projectId: "demo-g2-rules", firestore: { rules: RULES, ...emulatorHostPort() } })
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      for (const { name } of COLLECTIONS) await setDoc(doc(db, name, docIdFor(name)), seedFor(name))
      // Firm A's partner is a member of the matter (positive control). Every firm-B user also
      // holds a forged membership doc on the firm-A matter: the firm check alone must refuse.
      await setDoc(doc(db, "matter_members", `${MATTER_A}_${A_PARTNER}`), { firmId: FIRM_A, matterId: MATTER_A, userId: A_PARTNER })
      for (const role of ROLES) {
        await setDoc(doc(db, "matter_members", `${MATTER_A}_${bUid(role)}`), { firmId: FIRM_A, matterId: MATTER_A, userId: bUid(role) })
      }
      // SEC-3: every caller is a live identity (active users record matching its token), so only
      // the firm boundary can refuse firm B and the control succeeds on its own merits.
      await setDoc(doc(db, "users", A_PARTNER), { firmId: FIRM_A, role: "partner", clearanceLevel: MAX_CLEARANCE, active: true })
      for (const role of ROLES) {
        await setDoc(doc(db, "users", bUid(role)), { firmId: FIRM_B, role, clearanceLevel: MAX_CLEARANCE, active: true })
      }
    })
  })

  afterAll(async () => {
    await env?.cleanup()
  })

  it("every collection match in firestore.rules is swept (one per line), and the only platform-global ones are the reviewed list", () => {
    // Every `match /` is a collection except the /databases/{database}/documents root and the {document=**} catch-all.
    expect(COLLECTIONS.length).toBe(RULES.split("match /").length - 1 - 2)
    expect(RULES.split("\n").filter((line) => line.split("match /").length > 2)).toEqual([])
    expect(COLLECTIONS.filter((c) => isGlobal(c.block)).map((c) => c.name)).toEqual(REVIEWED_GLOBAL)
    for (const name of REVIEWED_GLOBAL) {
      rows.push({ suite: "functions", service: "rules", channel: "rules", path: name, status: "global", attempts: 0, allowed: 0, note: "platform-global (no tenant data)" })
    }
  })

  it("control: firm A's partner (a matter member) can read the seeded doc in every tenant collection, and is denied every server-only one", async () => {
    const db = env.authenticatedContext(A_PARTNER, { firmId: FIRM_A, role: "partner", clearanceLevel: MAX_CLEARANCE }).firestore()
    const failures: string[] = []
    for (const { name, block } of COLLECTIONS) {
      if (isGlobal(block)) continue
      if (isServerOnly(block)) {
        await assertFails(getDoc(doc(db, name, docIdFor(name)))).catch(() => failures.push(`${name}: server-only collection readable by firm A's partner`))
        continue
      }
      await assertSucceeds(getDoc(doc(db, name, docIdFor(name)))).catch((err: unknown) => failures.push(`${name}: ${String(err)}`))
    }
    expect(COLLECTIONS.filter((c) => isServerOnly(c.block)).length).toBeGreaterThan(0)
    expect(failures).toEqual([])
  })

  it("every firm-B role (max clearance, forged membership) is denied get and list on every tenant collection", async () => {
    const failures: string[] = []
    const tenant = COLLECTIONS.filter((c) => !isGlobal(c.block))
    const dbs = ROLES.map((role) => [role, env.authenticatedContext(bUid(role), { firmId: FIRM_B, role, clearanceLevel: MAX_CLEARANCE }).firestore()] as const)
    for (const { name } of tenant) {
      const results = await Promise.all(
        dbs.flatMap(([role, db]) => [
          assertFails(getDoc(doc(db, name, docIdFor(name)))).then(
            () => null,
            () => `${name} get by ${role}: ALLOWED`
          ),
          assertFails(getDocs(query(collection(db, name), where("firmId", "==", FIRM_A)))).then(
            () => null,
            () => `${name} list firmId==A by ${role}: ALLOWED`
          ),
        ])
      )
      const bad = results.filter((r): r is string => r !== null)
      failures.push(...bad)
      rows.push({ suite: "functions", service: "rules", channel: "rules", path: name, status: "tested", attempts: results.length, allowed: bad.length })
    }
    expect(failures).toEqual([])
  })

  it("platform/gates and gate_passes are server-only: no client (either firm) can read or write them", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "platform", "gates"), { g2PassedAt: "seeded" })
      await setDoc(doc(ctx.firestore(), "gate_passes", "p1"), { gate: "G-2" })
    })
    for (const [uid, firmId] of [[A_PARTNER, FIRM_A], [bUid("partner"), FIRM_B]] as const) {
      const db = env.authenticatedContext(uid, { firmId, role: "partner", clearanceLevel: MAX_CLEARANCE, platformAdmin: true }).firestore()
      await assertFails(getDoc(doc(db, "platform", "gates")))
      await assertFails(setDoc(doc(db, "platform", "gates"), { g2PassedAt: new Date() }))
      await assertFails(getDoc(doc(db, "gate_passes", "p1")))
      await assertFails(setDoc(doc(db, "gate_passes", "forged"), { gate: "G-2" }))
    }
  })
})
