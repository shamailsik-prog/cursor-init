import { onRequest } from "firebase-functions/v2/https"
import { INGRESS_SETTINGS } from "../deployConfig"
import { FUNCTION_TIMEOUT_SECONDS, REGION } from "../health"
import type { Operation } from "../p5/common"
import {
  approveMfaDisableOp,
  disableMfaOp,
  enforceMfaForRoleOp,
  generateRecoveryCodesOp,
  syncMfaStatusOp,
} from "../p5/mfa"
import { createFirmUserOp, deactivateUserOp, onboardFirmOp, setUserClaimsOp } from "../p5/identity"
import { recordGatePassOp } from "../p5/gates"
import { setFirmNumberingOp } from "../d1/client/numberingOp"
import { getClientOp, listClientsOp, registerClientOp } from "../d1/client/ops"
import { getConflictResultOp, getConflictTrailOp, recordPartnerWaiverOp, resolveReviewItemOp, runConflictCheckOp } from "../d1/conflict/ops"
import { advanceStageOp, closeMatterOp, getMatterOp, listMattersOp, openMatterOp } from "../d1/matter/ops"
import { getEntityOp, listAliasesOp, listReviewQueueOp } from "../d1/entity/read"
import { confirmMergeOp, disputeLinkOp, rejectLinkOp } from "../d1/entity/ops"
import { unmergeEntityOp } from "../d1/entity/unmerge"
import { cancelJobOp, getJobOp, listJobsOp, retryFailedJobOp } from "../p2/ops"
import { committeeBrainOp, getAiUsageOp, setAiKillSwitchOp, setBudgetAlertsOp, setPlatformAiKillSwitchOp } from "../p1/ops"
import { createDraftOp, getDraftOp, listDraftVersionsOp, listDraftsOp, restoreDraftVersionOp, saveDraftVersionOp } from "../d4/drafts"
import { getTypeProfileOp, listDocumentTypesOp } from "../d4/doctypeOps"
import { approveDraftOp, gateDraftOp, getVerificationReportOp, overrideGateOp } from "../d4/gateOps"
import { F02_NEXT_AUTHORITY_ROUTES } from "./f02NextAuthority"
import { createRouter, type Route } from "./routerRuntime"

/**
 * The HTTP entry `api` (L18 §4.1): GET/POST/PUT under /api/{domain}/{service}/{function},
 * with `Authorization: Bearer <ID token>` and `X-Firm-Id`. It is the only entry point to
 * the P5 operations (U-1: there are no onCall callables); the firm comes from X-Firm-Id,
 * never the body, and every POST needs an Idempotency-Key.
 *
 * Per request: route (404 route_not_found / 405 method_not_allowed) → body
 * checks for POST/PUT (413 payload_too_large over 1 MB, 415
 * unsupported_media_type unless JSON, 400 invalid_body unless an object) →
 * auth (401/403; a failure is audited as a deny unless the client IP is over
 * its per-minute limit, then 429) → per-user rate limit (429 + Retry-After) →
 * idempotency for POST/PUT (400 / 409 / 422, each audited as a deny; a replay
 * is not audited, nor is 409 idempotency_effect_committed, the stored answer of
 * an operation whose effect committed: audit F09) → handler.
 *
 * Responses: 2xx → the operation's JSON result; errors → `{ error: { code } }`.
 * A CommittedEffectError (a Next core wrote, then returned 4xx) also sends
 * `Idempotency-Effect-Committed` and `effectCommitted` (FA-F02-001).
 * GET data is the parsed query (string values only; 400 invalid_query otherwise); list GETs
 * paginate with d1/pagination.ts (§4.3).
 *
 * `createRouter` lives in `routerRuntime.ts` (no P1 ops import) so the F02 boundary can mount
 * only F02_NEXT_AUTHORITY_ROUTES without loading committeeBrain (FA-F18-014).
 */

export type { Method, Route } from "./routerRuntime"
export { MAX_BODY_BYTES, buildRouteTable, createRouter } from "./routerRuntime"

const IDENTITY = "/api/platform/identity"
const GATES = "/api/platform/gates"
const D1_CLIENT = "/api/d1/client"
const D1_CONFLICT = "/api/d1/conflict"
const D1_MATTER = "/api/d1/matter"
const D1_ENTITY = "/api/d1/entity"
const PLATFORM_JOBS = "/api/platform/jobs"
const PLATFORM_BRAIN = "/api/platform/brain"
const D4_DRAFTING = "/api/d4/drafting"
const D4_INTELLIGENCE = "/api/d4/intelligence"

const post = (path: string, handler: Operation, extra: Pick<Route, "redactReplay" | "idempotency"> = {}): Route => ({
  method: "POST",
  path,
  handler,
  kind: handler.kind,
  ...extra,
})

const get = (path: string, handler: Operation): Route => ({ method: "GET", path, handler, kind: handler.kind })

const RERUN = { idempotency: "rerun" } as const

export const ROUTES: readonly Route[] = [
  post(`${IDENTITY}/onboardFirm`, onboardFirmOp, RERUN),
  post(`${IDENTITY}/createFirmUser`, createFirmUserOp, RERUN),
  post(`${IDENTITY}/setUserClaims`, setUserClaimsOp, RERUN),
  post(`${IDENTITY}/deactivateUser`, deactivateUserOp, RERUN),
  post(`${IDENTITY}/enforceMfaForRole`, enforceMfaForRoleOp),
  post(`${IDENTITY}/approveMfaDisable`, approveMfaDisableOp),
  post(`${IDENTITY}/disableMfa`, disableMfaOp, RERUN),
  post(`${IDENTITY}/generateRecoveryCodes`, generateRecoveryCodesOp, { redactReplay: true }),
  post(`${IDENTITY}/syncMfaStatus`, syncMfaStatusOp),
  post(`${GATES}/recordGatePass`, recordGatePassOp),
  post(`${D1_CLIENT}/setFirmNumbering`, setFirmNumberingOp),
  post(`${D1_CLIENT}/registerClient`, registerClientOp),
  get(`${D1_CLIENT}/getClient`, getClientOp),
  get(`${D1_CLIENT}/listClients`, listClientsOp),
  post(`${D1_CONFLICT}/runConflictCheck`, runConflictCheckOp),
  get(`${D1_CONFLICT}/getConflictResult`, getConflictResultOp),
  post(`${D1_CONFLICT}/resolveReviewItem`, resolveReviewItemOp),
  post(`${D1_CONFLICT}/recordPartnerWaiver`, recordPartnerWaiverOp),
  get(`${D1_CONFLICT}/getConflictTrail`, getConflictTrailOp),
  post(`${D1_MATTER}/openMatter`, openMatterOp),
  get(`${D1_MATTER}/getMatter`, getMatterOp),
  get(`${D1_MATTER}/listMatters`, listMattersOp),
  post(`${D1_MATTER}/advanceStage`, advanceStageOp),
  post(`${D1_MATTER}/closeMatter`, closeMatterOp),
  get(`${D1_ENTITY}/listReviewQueue`, listReviewQueueOp),
  get(`${D1_ENTITY}/getEntity`, getEntityOp),
  get(`${D1_ENTITY}/listAliases`, listAliasesOp),
  post(`${D1_ENTITY}/confirmMerge`, confirmMergeOp),
  post(`${D1_ENTITY}/disputeLink`, disputeLinkOp),
  post(`${D1_ENTITY}/rejectLink`, rejectLinkOp),
  post(`${D1_ENTITY}/unmergeEntity`, unmergeEntityOp),
  get(`${PLATFORM_JOBS}/listJobs`, listJobsOp),
  get(`${PLATFORM_JOBS}/getJob`, getJobOp),
  post(`${PLATFORM_JOBS}/retryFailedJob`, retryFailedJobOp),
  post(`${PLATFORM_JOBS}/cancelJob`, cancelJobOp),
  post(`${PLATFORM_BRAIN}/committeeBrain`, committeeBrainOp, { idempotency: "resume" }),
  get(`${PLATFORM_BRAIN}/getAiUsage`, getAiUsageOp),
  post(`${PLATFORM_BRAIN}/setBudgetAlerts`, setBudgetAlertsOp),
  post(`${PLATFORM_BRAIN}/setAiKillSwitch`, setAiKillSwitchOp),
  post(`${PLATFORM_BRAIN}/setPlatformAiKillSwitch`, setPlatformAiKillSwitchOp),
  post(`${D4_DRAFTING}/createDraft`, createDraftOp),
  post(`${D4_DRAFTING}/saveDraftVersion`, saveDraftVersionOp),
  post(`${D4_DRAFTING}/restoreDraftVersion`, restoreDraftVersionOp),
  get(`${D4_DRAFTING}/getDraft`, getDraftOp),
  get(`${D4_DRAFTING}/listDrafts`, listDraftsOp),
  get(`${D4_DRAFTING}/listDraftVersions`, listDraftVersionsOp),
  post(`${D4_DRAFTING}/overrideGate`, overrideGateOp),
  post(`${D4_DRAFTING}/approveDraft`, approveDraftOp),
  get(`${D4_INTELLIGENCE}/listDocumentTypes`, listDocumentTypesOp),
  get(`${D4_INTELLIGENCE}/getTypeProfile`, getTypeProfileOp),
  post(`${D4_INTELLIGENCE}/gateDraft`, gateDraftOp),
  get(`${D4_INTELLIGENCE}/getVerificationReport`, getVerificationReportOp),
  ...F02_NEXT_AUTHORITY_ROUTES,
]

/** Built at module load, so a duplicate route fails the deploy bundle's first import. */
const router = createRouter(ROUTES)

export const api = onRequest(
  { region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS, ingressSettings: INGRESS_SETTINGS },
  router
)
