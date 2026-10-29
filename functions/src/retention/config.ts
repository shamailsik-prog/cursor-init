import { createHash } from "node:crypto"
import shippedInventory from "@/infra/retention/inventory.json"
import shippedPolicy from "@/infra/retention/policy.json"
import type { HoldRefusal, Treatment } from "./model"

/**
 * Audit F42: the retention policy (infra/retention/policy.json, versioned configuration, PROPOSED until the owner
 * ratifies it) and the data inventory (infra/retention/inventory.json, gated by ci_gates/check_data_inventory.py), as
 * the deletion saga and the retention job read them (spec R2, R3, R7 to R11).
 */

export type PolicyAction = "retain" | "purge" | "anonymise" | "expiry" | "external" | "lock"
export type PeriodicAction = "retain" | "purge" | "anonymise"

/**
 * What a class's period ages from (FA-F42-R1-011, spec R31): `row_age`, each row's own `ageField` (what
 * retention.apply executes); `matter_closure`, the matter's closure (Module 9 frames retention for closed matters; not
 * built, FU-8).
 */
export type PeriodBasis = "row_age" | "matter_closure"

export type ClassPolicy = {
  onMatterDeletion: PolicyAction
  legalHold: boolean
  periodDays: number | null
  periodicAction: PeriodicAction
  periodBasis: PeriodBasis
  basis: string
  proposed?: unknown
}

export type RetentionPolicy = {
  policyVersion: string
  status: string
  ratifiedBy: string | null
  ratifiedAt: string | null
  note?: string
  deletion: {
    approvalWindowHours: number
    ackDeadlineHours: number
    maxMembersRevokedAtApproval: number
    storesPerPurgeJob: number
    /** Days a partner's account and partner role must have run before they may request or approve (spec R26). */
    approverMinTenureDays: number
    /**
     * FA-F42-R1-006-003-001-001: when true, the sole independent partner may attest a partner they provisioned; when
     * false, `attestIndependentPartner` refuses with `attestation_sole_independent_provisioned_refused`.
     */
    allowSoleIndependentAttestationOfProvisionedPartners: boolean
    allowSoleIndependentAttestationNote?: string
    /** The closed list of codes a deletion request may give (spec R25). */
    reasonCodes: string[]
    reasonCodesNote?: string
    proposed?: string
  }
  /** Legal holds: the closed list of codes a hold may give (spec R25). */
  legalHold: { reasonCodes: string[]; note?: string }
  classes: Record<string, ClassPolicy>
}

/** The deletion saga's sizes (spec R32): rows per chunk, chunk steps per purge job, ids per trace part, trace parts. */
export type RetentionLimits = { chunk: number; chunkStepBudget: number; traceIdsPerPart: number; maxTraceParts: number }

export type StoreKey =
  | { kind: "docId" }
  | { kind: "field"; field: string }
  | { kind: "none" }
  | { kind: "ttl"; windowHours: number }
  | { kind: "objects"; via: string; pathField: string }
  | { kind: "traceExport"; sources: TraceSource[] }
  | { kind: "backup"; windowDays: number; config: string }

/**
 * Where a processor's copies are recorded: a field-keyed Firestore store whose rows carry the copy's id (`idField`)
 * and its export state (`statusField`); a row in one of `exportedValues` has (or may yet have) a copy there.
 */
export type TraceSource = { source: string; idField: string; statusField: string; exportedValues: string[] }

export type InventoryStore = {
  id: string
  kind: "firestore" | "objectPrefix" | "postgres" | "external" | "backup"
  name: string
  profile: string
  key: StoreKey
  anonymise?: Record<string, string | number | null>
  ageField?: { field: string; type: "timestamp" | "millis" }
  pending?: string
}

export type Inventory = {
  inventoryVersion: number
  profiles: Record<string, { classification: string; retentionClass: string; deleter: string; acknowledgement: string }>
  stores: InventoryStore[]
}

/** One store's place in a deletion: its key (the acknowledgement's id part), retention class and treatment. */
export type PlannedStore = { key: string; store: InventoryStore; retentionClass: string; treatment: Treatment }

/**
 * Test seams (never set in production code, and ignored when NODE_ENV is production): `policy` replaces the shipped
 * policy; `afterStep` runs after each committed fenced step of the saga (a throw there stands in for a crash after the
 * commit); `beforeAck` runs before a purge job's acknowledgement step (a write there stands in for a row that lands
 * after the purge).
 */
export const retentionTestSeam: {
  policy?: RetentionPolicy
  afterStep?: (stepId: string) => Promise<void>
  /** retention.apply: runs after a page is read and before its chunk's transaction (a hold placed here is a race). */
  beforeApplyChunk?: (storeKey: string) => Promise<void>
  /**
   * FA-F42-R1-013 (spec R32): smaller saga sizes, so a test of a continuation, a retry late in the budget or many traces
   * needs about 100 rows instead of 10,000. Each one left out keeps its production value.
   */
  limits?: Partial<RetentionLimits>
  /** FA-F42-R1-002-001-003-003: smaller trail row page for emulator tests (production keeps 300). */
  trailDocumentIdPageSize?: number
  beforeAck?: (part: string) => Promise<void>
  /** FA-F42-R2-001: runs inside halt()'s transaction after reads begin, before the hold is re-checked (race regression). */
  beforeHaltCommit?: (ctx: { firmId: string; matterId: string; requestId: string }) => Promise<void>
} = {}

/** The longest store key. Some legacy collection names run to 1,500 characters, past Firestore's field-name limit. */
export const MAX_STORE_KEY = 80

/**
 * A store's acknowledgement key (a field name of the request's `acked` and `plan` maps and part of an acknowledgement's
 * document id): its id with every character outside [A-Za-z0-9] as `_`; an id longer than `MAX_STORE_KEY` keeps its
 * first 48 characters and adds `_h` and 24 hex characters of its SHA-256. ci_gates/check_data_inventory.py computes the
 * same key and fails on a collision.
 */
export function storeKey(storeId: string): string {
  const plain = storeId.replace(/[^A-Za-z0-9]/g, "_")
  if (plain.length <= MAX_STORE_KEY) return plain
  return `${plain.slice(0, 48)}_h${createHash("sha256").update(storeId).digest("hex").slice(0, 24)}`
}

export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RetentionConfigError"
  }
}

const ACTIONS: ReadonlySet<string> = new Set(["retain", "purge", "anonymise", "expiry", "external", "lock"])
const PERIODIC: ReadonlySet<string> = new Set(["retain", "purge", "anonymise"])
const MATTER_KEYED: ReadonlySet<StoreKey["kind"]> = new Set(["docId", "field", "objects", "traceExport"])
const PERIOD_BASES: ReadonlySet<string> = new Set(["row_age", "matter_closure"])

/** Whether a class has a period that deletes (purge or anonymise), held or not. */
const deletingPeriod = (c: ClassPolicy): boolean => c.periodDays !== null && c.periodicAction !== "retain"

/** Whether retention.apply can age `s`: a Firestore store keyed by matter (doc id or field) with an ageField. */
export const ageable = (s: InventoryStore): boolean => s.kind === "firestore" && (s.key.kind === "docId" || s.key.kind === "field") && s.ageField !== undefined

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0

/** The shape of one reason code: lower case, a letter first, 3 to 64 characters (spec R25). */
export const REASON_CODE_SHAPE = /^[a-z][a-z0-9_]{2,63}$/

/** A closed list of reason codes: non-empty, each code-shaped, no duplicate. */
function reasonCodeList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === "string" && REASON_CODE_SHAPE.test(c)) && new Set(v).size === v.length
}

/** Checks the policy the code relies on (the CI gate checks the same file more fully); throws RetentionConfigError. */
export function validatePolicy(p: RetentionPolicy, inv: Inventory): void {
  if (typeof p.policyVersion !== "string" || p.policyVersion === "") throw new RetentionConfigError("policyVersion")
  const d = p.deletion
  if (!d || !positiveInt(d.approvalWindowHours) || !positiveInt(d.ackDeadlineHours) || !positiveInt(d.maxMembersRevokedAtApproval) || !positiveInt(d.storesPerPurgeJob)) {
    throw new RetentionConfigError("deletion")
  }
  if (!positiveInt(d.approverMinTenureDays)) throw new RetentionConfigError("deletion.approverMinTenureDays")
  if (typeof d.allowSoleIndependentAttestationOfProvisionedPartners !== "boolean") {
    throw new RetentionConfigError("deletion.allowSoleIndependentAttestationOfProvisionedPartners")
  }
  if (!reasonCodeList(d.reasonCodes)) throw new RetentionConfigError("deletion.reasonCodes")
  if (!p.legalHold || !reasonCodeList(p.legalHold.reasonCodes)) throw new RetentionConfigError("legalHold.reasonCodes")
  for (const [name, c] of Object.entries(p.classes ?? {})) {
    if (!ACTIONS.has(c.onMatterDeletion) || typeof c.legalHold !== "boolean" || !PERIODIC.has(c.periodicAction)) throw new RetentionConfigError(`class ${name}`)
    if (c.periodDays !== null && !positiveInt(c.periodDays)) throw new RetentionConfigError(`class ${name} periodDays`)
    // FA-F42-R1-011 (spec R31): every class names what its period ages from; aging from matter closure is not built.
    if (!PERIOD_BASES.has(c.periodBasis)) throw new RetentionConfigError(`class ${name} periodBasis`)
    if (deletingPeriod(c) && c.periodBasis === "matter_closure") throw new RetentionConfigError(`class ${name} periodBasis matter_closure (FU-8)`)
  }
  for (const s of inv.stores) {
    const cls = classOfStore(s, inv, p)
    if (cls === undefined) throw new RetentionConfigError(`store ${s.id} class`)
    const needsAnon = (s.key.kind === "docId" || s.key.kind === "field") && (cls.onMatterDeletion === "anonymise" || cls.periodicAction === "anonymise")
    if (needsAnon && (s.anonymise === undefined || Object.keys(s.anonymise).length === 0)) throw new RetentionConfigError(`store ${s.id} anonymise`)
    // An anonymised row of a field-keyed store must leave the matter's query, or the saga would find it again.
    if (s.anonymise !== undefined && s.key.kind === "field" && s.anonymise[s.key.field] !== null) throw new RetentionConfigError(`store ${s.id} anonymise key`)
    // FA-F42-R1-011 (spec R31): a deleting period covers every store of its class, or it is not adoptable: a store
    // retention.apply cannot age would keep rows the period was ratified to remove.
    if (deletingPeriod(cls) && !ageable(s)) throw new RetentionConfigError(`store ${s.id} period not applicable`)
  }
}

function classOfStore(s: InventoryStore, inv: Inventory, p: RetentionPolicy): ClassPolicy | undefined {
  const cls = inv.profiles[s.profile]?.retentionClass
  return cls === undefined ? undefined : p.classes[cls]
}

/** The shipped inventory. */
export function inventory(): Inventory {
  return shippedInventory as unknown as Inventory
}

/** The active policy: the shipped file, or the test seam outside production. Validated against the inventory. */
export function activePolicy(): RetentionPolicy {
  const seam = process.env.NODE_ENV === "production" ? undefined : retentionTestSeam.policy
  const p = seam ?? (shippedPolicy as unknown as RetentionPolicy)
  validatePolicy(p, inventory())
  return p
}

export function retentionClassOf(s: InventoryStore, inv: Inventory = inventory()): string {
  const cls = inv.profiles[s.profile]?.retentionClass
  if (cls === undefined) throw new RetentionConfigError(`store ${s.id} profile`)
  return cls
}

/**
 * How a deletion treats each store (spec R8): a store with no matter key is not applicable; TTL and backup stores
 * expire; the vault locks (or is retained); the trace processor gets an external request (or is retained); a
 * matter-keyed Firestore store is purged, anonymised or retained as its class says. An action the store cannot take
 * (expiry, external or lock on a Firestore matter store) is retained: nothing is destroyed by a misconfiguration.
 */
export function treatmentOf(s: InventoryStore, action: PolicyAction): Treatment {
  switch (s.key.kind) {
    case "none":
      return "not_applicable"
    case "ttl":
    case "backup":
      return "expiry"
    case "objects":
      return action === "lock" || action === "purge" ? "lock" : "retained"
    case "traceExport":
      return action === "external" || action === "purge" ? "external" : "retained"
    case "docId":
    case "field":
      return action === "purge" ? "purge" : action === "anonymise" ? "anonymise" : "retained"
  }
}

/** The deletion plan: every inventoried store, in inventory order, with its treatment under `p`. */
export function planDeletion(p: RetentionPolicy, inv: Inventory = inventory()): PlannedStore[] {
  return inv.stores.map((store) => {
    const retentionClass = retentionClassOf(store, inv)
    const cls = p.classes[retentionClass]
    if (!cls) throw new RetentionConfigError(`class ${retentionClass}`)
    return { key: storeKey(store.id), store, retentionClass, treatment: treatmentOf(store, cls.onMatterDeletion) }
  })
}

/**
 * The policy's legal hold (spec R9): any class that holds a matter-keyed store (a record, the vault or the trace
 * processor) with `legalHold: true` blocks the whole deletion, whatever its action.
 */
export function policyHolds(p: RetentionPolicy, plan: readonly PlannedStore[]): boolean {
  return plan.some((ps) => MATTER_KEYED.has(ps.store.key.kind) && p.classes[ps.retentionClass]?.legalHold === true)
}

/** The refusal a hold produces: the matter's own active hold first, then the policy's; null when nothing holds. */
export function holdRefusal(p: RetentionPolicy, plan: readonly PlannedStore[], hold: { active?: unknown; firmId?: unknown } | undefined, firmId: string): HoldRefusal | null {
  if (hold && hold.active === true && hold.firmId === firmId) return "legal_hold_matter"
  if (policyHolds(p, plan)) return "legal_hold_policy"
  return null
}

/** The inventory store a plan key names, or undefined. */
export function storeByKey(key: string, inv: Inventory = inventory()): InventoryStore | undefined {
  return inv.stores.find((s) => storeKey(s.id) === key)
}
