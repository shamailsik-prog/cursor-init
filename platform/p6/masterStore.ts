/**
 * Durable master store (Layer 17 L17.5; Layer 18 §5.4: Postgres is the system of record).
 * The in-memory adapter is the test and local proof. createPgMasterStore talks to Postgres
 * as the p6_service role (009_p6_master.sql). Neither adapter reports a commit it did not finish.
 */
import { randomUUID } from "node:crypto"
import pg from "pg"
import { isClassification, type Classification } from "@/platform/p1/types"

export type MasterSnapshot = {
  entries: Record<
    string,
    {
      partition: "mutable"
      key: string
      body: unknown
      classification: string
    }
  >
}

export type MasterDiff = {
  key: string
  partition: "mutable" | "immutable"
  before: MasterSnapshot
  after: MasterSnapshot
}

export type VersionRow = {
  id: string
  firmId: string
  versionNo: number
  proposalId: string | null
  parentVersionId: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  authorId: string
  authorKind: "partner" | "system"
  restoredFromVersionId: string | null
}

export type PersistedProposal = {
  id: string
  firmId: string
  sourceModule: string
  classification: Classification
  changeClass: "cosmetic" | "substantive"
  /** What the caller asked for. The server class is `changeClass` and is never lower than the diff. */
  requestedClass: "cosmetic" | "substantive" | null
  partition: "mutable" | "immutable"
  entryKey: string
  payload: unknown
  proposedBy: string
  status: "pending" | "approved" | "applied" | "rejected"
  decidedBy: string | null
  decidedKind: "partner" | "system" | null
  decidedRole: string | null
  declassify: boolean
}

export type CommitVersionInput = {
  firmId: string
  proposalId: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  authorId: string
  authorKind: "partner" | "system"
  restoredFromVersionId: string | null
  proposal: PersistedProposal | null
  classification: string
  /** Version id read under the firm lock. Null when the firm has no version yet. */
  expectedBaseVersionId: string | null
}

export type CommitVersionResult = { committed: true; versionId: string } | { committed: false }

export interface MasterStore {
  readonly role: string
  insertProposal(row: PersistedProposal): Promise<PersistedProposal>
  getProposal(id: string): Promise<PersistedProposal | null>
  saveProposal(row: PersistedProposal): Promise<void>
  listVersions(firmId: string): Promise<VersionRow[]>
  getVersion(id: string): Promise<VersionRow | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  /**
   * Writes the version, the current master snapshot and the proposal status in one transaction.
   * `committed: false` means the transaction was rolled back. A thrown error is the same fact.
   */
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
  /**
   * One write transaction. Memory: a mutex, restored if `fn` throws. Postgres: BEGIN, SET ROLE
   * p6_service, COMMIT, or ROLLBACK. The session's reads and writes share that transaction.
   */
  runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T>
}

export interface MasterSession {
  getProposal(id: string): Promise<PersistedProposal | null>
  currentSnapshot(firmId: string): Promise<MasterSnapshot>
  currentClassification(firmId: string): Promise<Classification>
  /** Locks the firm and returns the current version id, or null when the firm has none. */
  lockFirm(firmId: string): Promise<string | null>
  /** Status transition. False when the row is not in `fromStatus` (lost the race). */
  casProposal(row: PersistedProposal, fromStatus: PersistedProposal["status"]): Promise<boolean>
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>
  allowDeclassify(on: boolean): Promise<void>
}

export const P6_ROLE = "p6_service"
export const EMPTY_SNAPSHOT: MasterSnapshot = { entries: {} }

type MemoryState = {
  proposals: Map<string, PersistedProposal>
  versions: VersionRow[]
  heads: Map<string, MasterSnapshot>
  classes: Map<string, Classification>
}

function cloneState(state: MemoryState): MemoryState {
  return {
    proposals: new Map(structuredClone([...state.proposals.entries()])),
    versions: structuredClone(state.versions),
    heads: new Map(structuredClone([...state.heads.entries()])),
    classes: new Map(state.classes),
  }
}

export class InMemoryMasterStore implements MasterStore {
  readonly role: string
  private state: MemoryState = { proposals: new Map(), versions: [], heads: new Map(), classes: new Map() }
  private readonly failCommit: "throw" | "uncommitted" | undefined
  private gate: Promise<void> = Promise.resolve()

  constructor(options: { role: string; failCommit?: "throw" | "uncommitted" }) {
    this.role = options.role
    this.failCommit = options.failCommit
  }

  async runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T> {
    const previous = this.gate
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const snap = cloneState(this.state)
    try {
      return await fn(this)
    } catch (error) {
      this.state = snap
      throw error
    } finally {
      release()
    }
  }

  async lockFirm(firmId: string): Promise<string | null> {
    const versions = this.state.versions.filter((row) => row.firmId === firmId)
    return versions[versions.length - 1]?.id ?? null
  }

  async casProposal(row: PersistedProposal, fromStatus: PersistedProposal["status"]): Promise<boolean> {
    this.assertRole()
    const current = this.state.proposals.get(row.id)
    if (!current || current.status !== fromStatus) return false
    this.state.proposals.set(row.id, structuredClone(row))
    return true
  }

  async allowDeclassify(_on: boolean): Promise<void> {}

  async currentClassification(firmId: string): Promise<Classification> {
    return this.state.classes.get(firmId) ?? "internal"
  }

  private assertRole(): void {
    if (this.role !== P6_ROLE) throw new Error("non-P6 writer refused")
  }

  async insertProposal(row: PersistedProposal): Promise<PersistedProposal> {
    this.assertRole()
    const saved = structuredClone(row)
    this.state.proposals.set(saved.id, saved)
    return structuredClone(saved)
  }

  async getProposal(id: string): Promise<PersistedProposal | null> {
    const row = this.state.proposals.get(id)
    return row ? structuredClone(row) : null
  }

  async saveProposal(row: PersistedProposal): Promise<void> {
    this.assertRole()
    this.state.proposals.set(row.id, structuredClone(row))
  }

  async listVersions(firmId: string): Promise<VersionRow[]> {
    return this.state.versions.filter((row) => row.firmId === firmId).map((row) => structuredClone(row))
  }

  async getVersion(id: string): Promise<VersionRow | null> {
    const row = this.state.versions.find((item) => item.id === id)
    return row ? structuredClone(row) : null
  }

  async currentSnapshot(firmId: string): Promise<MasterSnapshot> {
    return structuredClone(this.state.heads.get(firmId) ?? EMPTY_SNAPSHOT)
  }

  async commitVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    this.assertRole()
    const snap = cloneState(this.state)
    try {
      const firmVersions = this.state.versions.filter((row) => row.firmId === input.firmId)
      const parent = firmVersions[firmVersions.length - 1] ?? null
      if ((parent?.id ?? null) !== input.expectedBaseVersionId) {
        throw new Error("master version conflict")
      }
      if (input.proposalId && firmVersions.some((row) => row.proposalId === input.proposalId)) {
        throw new Error("proposal already has a version")
      }
      const version: VersionRow = {
        id: randomUUID(),
        firmId: input.firmId,
        versionNo: (parent?.versionNo ?? 0) + 1,
        proposalId: input.proposalId,
        parentVersionId: parent?.id ?? null,
        action: input.action,
        diff: structuredClone(input.diff),
        snapshot: structuredClone(input.snapshot),
        authorId: input.authorId,
        authorKind: input.authorKind,
        restoredFromVersionId: input.restoredFromVersionId,
      }
      this.state.versions.push(version)
      this.state.heads.set(input.firmId, structuredClone(input.snapshot))
      if (isClassification(input.classification)) this.state.classes.set(input.firmId, input.classification)
      if (input.proposal) this.state.proposals.set(input.proposal.id, structuredClone(input.proposal))
      if (this.failCommit === "throw") {
        this.state = snap
        throw new Error("master write did not commit")
      }
      if (this.failCommit === "uncommitted") {
        this.state = snap
        return { committed: false }
      }
      return { committed: true, versionId: version.id }
    } catch (error) {
      this.state = snap
      throw error
    }
  }
}

type VersionQueryRow = {
  id: string
  firm_id: string
  version_no: number
  proposal_id: string | null
  parent_version_id: string | null
  action: "apply" | "rollback"
  diff: MasterDiff
  snapshot: MasterSnapshot
  author_id: string
  author_kind: "partner" | "system"
  restored_from_version_id: string | null
}

type ProposalQueryRow = {
  id: string
  firm_id: string
  source_module: string
  classification: Classification
  change_class: "cosmetic" | "substantive"
  partition: "mutable" | "immutable"
  entry_key: string
  payload: unknown
  proposed_by: string
  status: PersistedProposal["status"]
  decided_by: string | null
  decided_kind: PersistedProposal["decidedKind"]
  decided_role: string | null
  requested_class: PersistedProposal["requestedClass"]
  declassify: boolean
}

function versionFromRow(row: VersionQueryRow): VersionRow {
  return {
    id: row.id,
    firmId: row.firm_id,
    versionNo: row.version_no,
    proposalId: row.proposal_id,
    parentVersionId: row.parent_version_id,
    action: row.action,
    diff: row.diff,
    snapshot: row.snapshot,
    authorId: row.author_id,
    authorKind: row.author_kind,
    restoredFromVersionId: row.restored_from_version_id,
  }
}

function proposalFromRow(row: ProposalQueryRow): PersistedProposal {
  return {
    id: row.id,
    firmId: row.firm_id,
    sourceModule: row.source_module,
    classification: row.classification,
    changeClass: row.change_class,
    partition: row.partition,
    entryKey: row.entry_key,
    payload: row.payload,
    proposedBy: row.proposed_by,
    status: row.status,
    decidedBy: row.decided_by,
    decidedKind: row.decided_kind,
    decidedRole: row.decided_role,
    requestedClass: row.requested_class,
    declassify: row.declassify,
  }
}

const PROPOSAL_COLUMNS = `id, firm_id, source_module, classification, change_class, partition, entry_key,
  payload, proposed_by, status, decided_by, decided_kind, decided_role, requested_class, declassify`

/**
 * Postgres adapter. Every call sets the session role to p6_service for that transaction.
 * The migration's grants and writer trigger refuse any other role. A failed commit throws;
 * the caller must not treat that as masterWritten.
 */
export function createPgMasterStore(pool: pg.Pool): MasterStore {
  async function withRole<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL ROLE p6_service")
      const result = await fn(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      try {
        await client.query("ROLLBACK")
      } catch {
        // The original error is the one the caller must see.
      }
      throw error
    } finally {
      client.release()
    }
  }

  return {
    role: P6_ROLE,

    async insertProposal(row) {
      await withRole(async (client) => {
        await client.query(
          `INSERT INTO change_proposals
             (id, firm_id, source_module, classification, change_class, partition, entry_key,
              payload, proposed_by, status, decided_by, decided_kind, decided_role, requested_class, declassify)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
          [
            row.id,
            row.firmId,
            row.sourceModule,
            row.classification,
            row.changeClass,
            row.partition,
            row.entryKey,
            JSON.stringify(row.payload),
            row.proposedBy,
            row.status,
            row.decidedBy,
            row.decidedKind,
            row.decidedRole,
            row.requestedClass,
            row.declassify,
          ],
        )
      })
      return row
    },

    async getProposal(id) {
      return withRole(async (client) => {
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1`,
          [id],
        )
        const row = found.rows[0]
        return row ? proposalFromRow(row) : null
      })
    },

    async saveProposal(row) {
      const updated = await withRole(async (client) => {
        const result = await client.query(
          `UPDATE change_proposals
              SET status = $2, decided_by = $3, decided_kind = $4, decided_role = $5
            WHERE id = $1`,
          [row.id, row.status, row.decidedBy, row.decidedKind, row.decidedRole],
        )
        return result.rowCount ?? 0
      })
      if (updated !== 1) throw new Error("proposal not found")
    },

    async listVersions(firmId) {
      return withRole(async (client) => {
        const found = await client.query<VersionQueryRow>(
          `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                  author_id, author_kind, restored_from_version_id
             FROM master_versions WHERE firm_id = $1 ORDER BY version_no`,
          [firmId],
        )
        return found.rows.map(versionFromRow)
      })
    },

    async getVersion(id) {
      return withRole(async (client) => {
        const found = await client.query<VersionQueryRow>(
          `SELECT id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
                  author_id, author_kind, restored_from_version_id
             FROM master_versions WHERE id = $1`,
          [id],
        )
        const row = found.rows[0]
        return row ? versionFromRow(row) : null
      })
    },

    async currentSnapshot(firmId) {
      return withRole(async (client) => {
        const found = await client.query<{ snapshot: MasterSnapshot }>(
          `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
          [firmId],
        )
        return found.rows[0]?.snapshot ?? EMPTY_SNAPSHOT
      })
    },

    async currentClassification(firmId) {
      return withRole(async (client) => readClassification(client, firmId))
    },

    async commitVersion(input) {
      const versionId = randomUUID()
      try {
        await withRole(async (client) => {
          await writeVersion(client, input, versionId)
        })
      } catch (error) {
        throw commitError(error)
      }
      return { committed: true, versionId }
    },

    async runExclusive(fn) {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SET LOCAL ROLE p6_service")
        const result = await fn(session(client))
        await client.query("COMMIT")
        return result
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // The original error is the one the caller must see.
        }
        throw error
      } finally {
        client.release()
      }
    },
  }

  function session(client: pg.PoolClient): MasterSession {
    return {
      async getProposal(id) {
        const found = await client.query<ProposalQueryRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM change_proposals WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const row = found.rows[0]
        return row ? proposalFromRow(row) : null
      },
      async currentSnapshot(firmId) {
        const found = await client.query<{ snapshot: MasterSnapshot }>(
          `SELECT snapshot FROM master_knowledge WHERE firm_id = $1`,
          [firmId],
        )
        return found.rows[0]?.snapshot ?? EMPTY_SNAPSHOT
      },
      async currentClassification(firmId) {
        return readClassification(client, firmId)
      },
      async lockFirm(firmId) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`p6:${firmId}`])
        const found = await client.query<{ version_id: string }>(
          `SELECT version_id FROM master_knowledge WHERE firm_id = $1 FOR UPDATE`,
          [firmId],
        )
        return found.rows[0]?.version_id ?? null
      },
      async casProposal(row, fromStatus) {
        const updated = await client.query(
          `UPDATE change_proposals
              SET status = $2, decided_by = $3, decided_kind = $4, decided_role = $5,
                  change_class = $6, declassify = $7
            WHERE id = $1 AND status = $8`,
          [row.id, row.status, row.decidedBy, row.decidedKind, row.decidedRole, row.changeClass, row.declassify, fromStatus],
        )
        return (updated.rowCount ?? 0) === 1
      },
      async allowDeclassify(on) {
        await client.query("SELECT set_config('p6.declassify', $1, true)", [on ? "partner" : "off"])
      },
      async commitVersion(input) {
        const versionId = randomUUID()
        try {
          await writeVersion(client, input, versionId)
        } catch (error) {
          throw commitError(error)
        }
        return { committed: true, versionId }
      },
    }
  }
}

async function readClassification(client: pg.PoolClient, firmId: string): Promise<Classification> {
  const found = await client.query<{ classification: string }>(
    `SELECT classification FROM master_knowledge WHERE firm_id = $1`,
    [firmId],
  )
  const label = found.rows[0]?.classification
  return isClassification(label) ? label : "internal"
}

function commitError(error: unknown): Error {
  if (error instanceof Error && /did not commit|non-P6 writer refused|master version conflict|proposal already has a version|declassify|frozen/.test(error.message)) {
    return error
  }
  return new Error("master write did not commit", { cause: error })
}

async function writeVersion(client: pg.PoolClient, input: CommitVersionInput, versionId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`p6:${input.firmId}`])
  const prior = await client.query<{ version_no: number; id: string }>(
    `SELECT version_no, id FROM master_versions
      WHERE firm_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [input.firmId],
  )
  const parent = prior.rows[0]
  if ((parent?.id ?? null) !== input.expectedBaseVersionId) throw new Error("master version conflict")
  const versionNo = (parent?.version_no ?? 0) + 1
  await client.query(
    `INSERT INTO master_versions
       (id, firm_id, version_no, proposal_id, parent_version_id, action, diff, snapshot,
        author_id, author_kind, restored_from_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [
      versionId,
      input.firmId,
      versionNo,
      input.proposalId,
      parent?.id ?? null,
      input.action,
      JSON.stringify(input.diff),
      JSON.stringify(input.snapshot),
      input.authorId,
      input.authorKind,
      input.restoredFromVersionId,
    ],
  )
  const written = await client.query(
    `INSERT INTO master_knowledge (firm_id, snapshot, classification, version_id)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (firm_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           classification = EXCLUDED.classification,
           version_id = EXCLUDED.version_id
       WHERE master_knowledge.version_id IS NOT DISTINCT FROM $5
     RETURNING firm_id`,
    [input.firmId, JSON.stringify(input.snapshot), input.classification, versionId, input.expectedBaseVersionId],
  )
  if ((written.rowCount ?? 0) !== 1) throw new Error("master version conflict")
}
