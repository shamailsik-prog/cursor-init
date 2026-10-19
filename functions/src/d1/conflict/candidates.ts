import type { Query, QuerySnapshot } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { isFirestoreDocId } from "../../p5/common"
import { buildRegistry, firmMapOf, readFirmForFlag, type Registry, type Row } from "./engine"
import { NAME_THRESHOLD, nameScore, type Keys, type Subject } from "./match"
import { indexedNamesOf, nameIndexProblem, NameIndexUnavailable, readNameIndex } from "./nameIndex"
import { nameForms, usesFallback } from "./normalise"

/**
 * The candidate loader (audit F37; spec 2026-10-18-f37 rulings 1, 2 and 6). A screen produces a hit for a
 * (subject, candidate) pair only on (1) the subject client's own entity, (2) an equal non-empty key, or (3) a
 * name score ≥ NAME_THRESHOLD (match.ts `screen`). So instead of the whole registry it reads, all scoped to the
 * firm:
 *
 * - the registry version with the name index state (one read, first: a registry write after it moves the version);
 * - the firm doc (L17.2 flag), the transliteration map, and the name index chunks;
 * - clients and opposing parties whose entity is a client subject's (1), whose key equals a subject's (2), or
 *   whose exact name is one of the indexed names the engine's own `nameScore` matches to a subject (3);
 * - the matters of those clients, the matters of those parties (only the firm's), and the entity links that
 *   touch their entities (`tailor` reads no other link).
 *
 * The rows go through `buildRegistry`, sorted by document id as the full scan returned them, so `runEngine`
 * gives exactly the full scan's hits. Reads: O(keys + candidates) plus one chunk per ~20,000 indexed names.
 */

/** Firestore's limit on the values of one `in` filter. */
export const IN_LIMIT = 30

const KEY_NAMES = ["cnic", "ntn", "secp", "phone"] as const satisfies ReadonlyArray<keyof Keys>
/** The client field holding each key (clientKeys in engine.ts reads the same fields). */
const CLIENT_KEY_FIELD: Record<keyof Keys, string> = { cnic: "cnic", ntn: "ntn", secp: "secpNumber", phone: "primaryMobile" }

export type ScreeningLoad = {
  /** The registry restricted to the candidates that can hit one of the subjects. */
  registry: Registry
  /** The registry version read with the index state, before any registry row (openMatter compares it in its transaction). */
  version: number
}

const rowsOf = (snap: QuerySnapshot): Row[] => snap.docs.map((d) => ({ id: d.id, data: d.data() }))

/** `values` in consecutive lists of at most IN_LIMIT, every value exactly once and in order (one `in` query each). */
export function inLists<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += IN_LIMIT) out.push(values.slice(i, i + IN_LIMIT))
  return out
}

/** Queries of one screen in flight at once at most (F37 re-audit INFO): the `in` lists fan out at one query per 30 values. */
export const QUERY_CONCURRENCY = 8

/** A limiter: `run(fn)` starts `fn` once fewer than `max` started functions are still running. */
export function concurrencyLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

type Run = <T>(fn: () => Promise<T>) => Promise<T>

/** The rows of `base` whose `field` is one of `values` (one query per 30 values through `run`; none when there are no values). */
async function rowsWhereIn(run: Run, base: Query, field: string, values: readonly string[]): Promise<Row[]> {
  if (values.length === 0) return []
  const snaps = await Promise.all(inLists(values).map((vs) => run(() => base.where(field, "in", vs).get())))
  return snaps.flatMap(rowsOf)
}

/** Rows deduplicated by id and sorted by id: the order of a Firestore query with equality filters only. */
function byIdOrder(rows: readonly Row[]): Row[] {
  const seen = new Map<string, Row>()
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r)
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const distinct = (values: readonly unknown[]): string[] => [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))]

/**
 * The names among `names` that can produce a name hit for some subject: the engine's own `nameScore` over the
 * same forms (`nameForms` with the firm map) and the same lossy-fallback rule `runEngine` applies (pure).
 */
export function matchingNames(names: Iterable<string>, subjects: readonly Subject[], firmMap: ReadonlyMap<string, string[]>): string[] {
  const subjectForms = subjects.map((s) => nameForms(s.name, firmMap))
  const fallback = subjects.map((s) => usesFallback(s.name, firmMap))
  const out: string[] = []
  for (const name of names) {
    const forms = nameForms(name, firmMap)
    if (subjectForms.some((f, i) => nameScore(f, forms, fallback[i]) >= NAME_THRESHOLD)) out.push(name)
  }
  return out
}

/**
 * The screening registry for `subjects` at `now` (`subjectEntityIds[i]`: the entity of a `clientId` subject).
 * Throws NameIndexUnavailable when the index is missing, of another schema, behind the registry or unreadable:
 * the caller refuses the screen (spec ruling 5).
 */
export async function loadScreeningRegistry(
  firmId: string,
  subjects: readonly Subject[],
  subjectEntityIds: readonly (string | undefined)[],
  now: Date
): Promise<ScreeningLoad> {
  const db = adminDb()
  const run = concurrencyLimit(QUERY_CONCURRENCY)
  // The counter, every chunk of the firm and (without a counter doc) the empty-registry probe, in one consistent read.
  const index = await readNameIndex(firmId, { probeEmpty: true })
  const state = index.state
  const problem = nameIndexProblem(state)
  // No counter doc: no registry write through functions/src yet. With no candidate row either, the empty index is
  // complete; a row there was written out of band and the index stays missing until reconciled.
  const empty = problem === "missing" && !state.exists && index.registryEmpty === true
  if (problem !== null && !empty) throw new NameIndexUnavailable(problem)
  const indexedNames = empty ? new Set<string>() : indexedNamesOf(firmId, state, index.chunks)

  const [firm, mapSnap] = await Promise.all([readFirmForFlag(firmId), db.collection("transliteration_map").where("firmId", "==", firmId).get()])
  const maps = rowsOf(mapSnap)
  const names = matchingNames(indexedNames, subjects, firmMapOf(maps))

  const clientsQ = db.collection("clients").where("firmId", "==", firmId)
  const partiesQ = db.collection("matter_parties").where("firmId", "==", firmId).where("role", "==", "opposing")
  // An empty registry has no candidate to fetch: every tier is skipped.
  const keyValues = (k: keyof Keys) => (empty ? [] : distinct(subjects.map((s) => s.keys[k])))
  // Condition (1) applies only to a registered-client subject (match.ts: `subject.clientId ? subjectEntityIds[i]`).
  const entities = empty ? [] : distinct(subjects.map((s, i) => (s.clientId ? subjectEntityIds[i] : undefined)))

  const [clientSets, partySets] = await Promise.all([
    Promise.all([
      rowsWhereIn(run, clientsQ, "canonicalName", names),
      rowsWhereIn(run, clientsQ, "entityId", entities),
      ...KEY_NAMES.map((k) => rowsWhereIn(run, clientsQ, CLIENT_KEY_FIELD[k], keyValues(k))),
    ]),
    Promise.all([
      rowsWhereIn(run, partiesQ, "name", names),
      rowsWhereIn(run, partiesQ, "entityId", entities),
      ...KEY_NAMES.map((k) => rowsWhereIn(run, partiesQ, `keys.${k}`, keyValues(k))),
    ]),
  ])
  const clients = byIdOrder(clientSets.flat())
  const parties = byIdOrder(partySets.flat())

  // Every matter of each client (its live-matter flag and one candidate per matter), and each party's matter if it is the firm's.
  const partyMatterIds = distinct(parties.map((p) => p.data.matterId)).filter((id) => isFirestoreDocId(id))
  const entityIds = distinct([...clients, ...parties].map((r) => r.data.entityId))
  const linksQ = db.collection("entity_links").where("firmId", "==", firmId)
  const [clientMatters, partyMatterSnaps, left, right] = await Promise.all([
    rowsWhereIn(run, db.collection("matters").where("firmId", "==", firmId), "clientId", clients.map((c) => c.id)),
    partyMatterIds.length > 0 ? db.getAll(...partyMatterIds.map((id) => db.collection("matters").doc(id))) : Promise.resolve([]),
    rowsWhereIn(run, linksQ, "leftId", entityIds),
    rowsWhereIn(run, linksQ, "rightId", entityIds),
  ])
  const partyMatters: Row[] = []
  for (const s of partyMatterSnaps) {
    const data = s.data()
    if (data !== undefined && data.firmId === firmId) partyMatters.push({ id: s.id, data })
  }

  const registry = buildRegistry(
    { firm, clients, matters: byIdOrder([...clientMatters, ...partyMatters]), parties, links: byIdOrder([...left, ...right]), maps },
    now
  )
  return { registry, version: state.version }
}
