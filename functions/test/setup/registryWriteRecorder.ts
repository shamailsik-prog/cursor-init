/**
 * Registry-version write recorder (spec P3-20), a vitest setup file over every functions test.
 *
 * `d1/registryVersion.ts` requires every write that changes what `loadRegistry` reads to bump the
 * firm's registry version (`counters/<firmId>_registry`) in that write's own transaction. This file
 * patches the Firestore Admin SDK's write methods at test time only (nothing in functions/src imports
 * it) and records:
 *
 * - every registry write made by product code (the first stack frame outside node_modules and outside
 *   this file lies under functions/src/) in a transaction attempt that stages no bump for the written
 *   row's firm (`no_bump`), checked when the transaction's update function resolves;
 * - every product registry write through a WriteBatch or a DocumentReference (`outside_transaction`).
 *
 * A registry write is a write to a collection in `REGISTRY_SCOPE` that is a delete; a create or a
 * non-merge set whose data names an in-scope field; or an update or merge set touching one (the
 * top-level segment of each field path). Field scopes: `all`, `except` (any field but those), `only`.
 *
 * Every violation not taken by the test (`registryRecorder.take()`) fails it in `afterEach`. Writes
 * from test files are never product writes, so seeding fixtures is unaffected.
 *
 * Known limits (spec P3-20 accepts that an unexercised path escapes):
 * - A non-merge `set` counts only when its data names an in-scope field (the brief's rule, so that
 *   onboardFirm's `firms` create is not flagged). A non-merge set of `{ stage }` on a `matters` row,
 *   which would wipe its other fields, is therefore treated as exempt; no writer in functions/src does it.
 * - BulkWriter and `recursiveDelete` are not patched; p2.registry-recorder-attribution.emu.test.ts fails
 *   if functions/src uses either.
 * - The read log (`readsDuring`) sees `Query.get` and `DocumentReference.get` only, not `getAll`,
 *   `stream` or `onSnapshot`; a loadRegistry read through those would not be noticed.
 * - Violations are attributed by global state, not by test id: a product write that lands after its
 *   test's afterEach (an unawaited write, background work) is reported in whichever test is running
 *   then, or lost if none is.
 * - Real stack attribution is proven by p2.registry-recorder-attribution.emu.test.ts (a real writer
 *   with its bump stubbed out), not by the gate test, which uses `attributeTo`.
 *
 * Patches are installed once per process (Node's module cache shares the SDK across test files);
 * the recorder's state lives on `globalThis` for the same reason.
 */
import path from "node:path"
import { afterEach } from "vitest"
import { DocumentReference, Firestore, Query, Transaction, WriteBatch, FieldPath } from "firebase-admin/firestore"
import { REGISTRY_SCOPE } from "../../src/d1/registryVersion"

export type RegistryViolation = { file: string; line: number; collection: string; reason: "no_bump" | "outside_transaction" }

type Site = { file: string; line: number; product: boolean }
type PendingWrite = { site: Site; collection: string; firmId: string | null }
type Attempt = { writes: PendingWrite[]; bumps: Set<string> }

type RecorderState = {
  violations: RegistryViolation[]
  override: Site | null
  /** Depth of patched calls on the stack: a write nested in another patched write (tx.set → its WriteBatch) is not re-recorded. */
  depth: number
  attempts: WeakMap<object, Attempt>
  readSinks: Set<Set<string>>
}

const STATE_KEY = Symbol.for("sikander.registryWriteRecorder.state")
const PATCHED_KEY = Symbol.for("sikander.registryWriteRecorder.patched")
type Global = typeof globalThis & { [STATE_KEY]?: RecorderState; [PATCHED_KEY]?: boolean }
const g = globalThis as Global
const state: RecorderState = (g[STATE_KEY] ??= {
  violations: [],
  override: null,
  depth: 0,
  attempts: new WeakMap(),
  readSinks: new Set(),
})

const THIS_FILE = __filename
const FUNCTIONS_DIR = path.resolve(__dirname, "../..")
const SRC_DIR = path.join(FUNCTIONS_DIR, "src") + path.sep
const REPO_DIR = path.dirname(FUNCTIONS_DIR)

const display = (file: string) => path.relative(REPO_DIR, file).split(path.sep).join("/")

/** The writing site: the `attributeTo` override, else the first stack frame outside node_modules and this file. */
function siteOf(): Site {
  if (state.override) return state.override
  const stack = new Error().stack ?? ""
  for (const raw of stack.split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/.exec(raw.trim())
    if (!m) continue
    const file = m[1].startsWith("file://") ? new URL(m[1]).pathname : m[1]
    if (file === THIS_FILE || file.includes(`${path.sep}node_modules${path.sep}`)) continue
    return { file: display(file), line: Number(m[2]), product: file.startsWith(SRC_DIR) }
  }
  return { file: "<unknown>", line: 0, product: false }
}

function parseOverride(site: string): Site {
  const i = site.lastIndexOf(":")
  const file = i > 0 ? site.slice(0, i) : site
  const line = i > 0 ? Number(site.slice(i + 1)) : 0
  return { file, line, product: file.startsWith("functions/src/") }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function topSegment(field: unknown): string {
  if (field instanceof FieldPath) {
    const segments = (field as unknown as { segments?: string[] }).segments
    if (Array.isArray(segments) && segments.length > 0) return segments[0]
    return String(field).split(".")[0]
  }
  return String(field).split(".")[0]
}

function inScope(collection: string, fields: string[]): boolean {
  const scope = REGISTRY_SCOPE[collection]
  if (!scope) return false
  if ("all" in scope) return fields.length > 0
  if ("except" in scope) return fields.some((f) => !scope.except.includes(f))
  return fields.some((f) => scope.only.includes(f))
}

type WriteKind = "create" | "set" | "update" | "delete"

/** The written firm (`firmId` named in the data) when the write is a registry write; `undefined` when it is not one. */
function registryWrite(kind: WriteKind, ref: DocumentReference, args: unknown[]): { firmId: string | null } | undefined {
  const collection = ref.parent.id
  if (!REGISTRY_SCOPE[collection]) return undefined
  const firmOf = (data: unknown) => (isPlainObject(data) && typeof data.firmId === "string" ? data.firmId : null)
  if (kind === "delete") return { firmId: null }
  if (kind === "create") {
    const data = args[0]
    return isPlainObject(data) && inScope(collection, Object.keys(data).map(topSegment)) ? { firmId: firmOf(data) } : undefined
  }
  if (kind === "set") {
    const [data, options] = args as [unknown, { merge?: boolean; mergeFields?: unknown[] } | undefined]
    if (!isPlainObject(data)) return undefined
    const fields = Array.isArray(options?.mergeFields) ? options.mergeFields.map(topSegment) : Object.keys(data).map(topSegment)
    return inScope(collection, fields) ? { firmId: firmOf(data) } : undefined
  }
  // update(data, precondition?) or update(field, value, field, value, ..., precondition?)
  const first = args[0]
  if (typeof first === "string" || first instanceof FieldPath) {
    const fields: string[] = []
    for (let i = 0; i + 1 < args.length; i += 2) fields.push(topSegment(args[i]))
    const firmIdx = fields.indexOf("firmId")
    const firmId = firmIdx >= 0 && typeof args[firmIdx * 2 + 1] === "string" ? (args[firmIdx * 2 + 1] as string) : null
    return inScope(collection, fields) ? { firmId } : undefined
  }
  if (!isPlainObject(first)) return undefined
  return inScope(collection, Object.keys(first).map(topSegment)) ? { firmId: firmOf(first) } : undefined
}

/** `counters/<firmId>_registry` → firmId. */
function bumpedFirm(ref: DocumentReference): string | null {
  if (ref.parent.id !== "counters" || ref.parent.parent !== null) return null
  return ref.id.endsWith("_registry") ? ref.id.slice(0, -"_registry".length) : null
}

function pushViolation(v: RegistryViolation): void {
  const dup = state.violations.some((o) => o.file === v.file && o.line === v.line && o.collection === v.collection && o.reason === v.reason)
  if (!dup) state.violations.push(v)
}

type Method = (this: unknown, ...args: unknown[]) => unknown

function nested<T>(fn: () => T): T {
  state.depth++
  try {
    return fn()
  } finally {
    state.depth--
  }
}

function patchWrites(proto: Record<string, unknown>, via: "transaction" | "batch" | "reference"): void {
  for (const kind of ["create", "set", "update", "delete"] as const) {
    const original = proto[kind] as Method
    proto[kind] = function patched(this: unknown, ...all: unknown[]) {
      if (state.depth === 0) {
        const ref = (via === "reference" ? this : all[0]) as DocumentReference
        const args = via === "reference" ? all : all.slice(1)
        if (ref instanceof DocumentReference) {
          if (via === "transaction") {
            const attempt = state.attempts.get(this as object)
            if (attempt) {
              const bumped = kind === "set" ? bumpedFirm(ref) : null
              if (bumped !== null) attempt.bumps.add(bumped)
              const w = registryWrite(kind, ref, args)
              if (w) {
                const site = siteOf()
                if (site.product) attempt.writes.push({ site, collection: ref.parent.id, firmId: w.firmId })
              }
            }
          } else {
            const w = registryWrite(kind, ref, args)
            if (w) {
              const site = siteOf()
              if (site.product) pushViolation({ file: site.file, line: site.line, collection: ref.parent.id, reason: "outside_transaction" })
            }
          }
        }
      }
      return nested(() => original.apply(this, all))
    }
  }
}

function checkAttempt(attempt: Attempt): void {
  for (const w of attempt.writes) {
    const ok = w.firmId === null ? attempt.bumps.size > 0 : attempt.bumps.has(w.firmId)
    if (!ok) pushViolation({ file: w.site.file, line: w.site.line, collection: w.collection, reason: "no_bump" })
  }
}

function noteRead(collection: string): void {
  for (const sink of state.readSinks) sink.add(collection)
}

function install(): void {
  if (g[PATCHED_KEY]) return
  g[PATCHED_KEY] = true
  patchWrites(Transaction.prototype as unknown as Record<string, unknown>, "transaction")
  patchWrites(WriteBatch.prototype as unknown as Record<string, unknown>, "batch")
  patchWrites(DocumentReference.prototype as unknown as Record<string, unknown>, "reference")

  const fsProto = Firestore.prototype as unknown as { runTransaction: Method }
  const runTransaction = fsProto.runTransaction
  fsProto.runTransaction = function patchedRunTransaction(this: unknown, updateFunction: unknown, ...rest: unknown[]) {
    if (typeof updateFunction !== "function") return runTransaction.call(this, updateFunction, ...rest)
    const wrapped = async (tx: Transaction) => {
      // A fresh record per attempt: the SDK re-runs the update function on the same Transaction.
      const attempt: Attempt = { writes: [], bumps: new Set() }
      state.attempts.set(tx, attempt)
      const result = await (updateFunction as (t: Transaction) => unknown)(tx)
      checkAttempt(attempt)
      return result
    }
    return runTransaction.call(this, wrapped, ...rest)
  }

  const queryProto = Query.prototype as unknown as { get: Method }
  const queryGet = queryProto.get
  queryProto.get = function patchedQueryGet(this: unknown, ...args: unknown[]) {
    const id = (this as { _queryOptions?: { collectionId?: string } })._queryOptions?.collectionId
    if (typeof id === "string") noteRead(id)
    return queryGet.apply(this, args)
  }
  const refProto = DocumentReference.prototype as unknown as { get: Method }
  const refGet = refProto.get
  refProto.get = function patchedRefGet(this: unknown, ...args: unknown[]) {
    noteRead((this as DocumentReference).parent.id)
    return refGet.apply(this, args)
  }
}

install()

export const registryRecorder = {
  /** Returns and clears the violations recorded so far. */
  take(): RegistryViolation[] {
    return state.violations.splice(0)
  },
  /** Attributes every following write to `site` ("<file>:<line>"); `null` restores stack attribution. */
  attributeTo(site: string | null): void {
    state.override = site === null ? null : parseOverride(site)
  },
  /** The collection ids of every get() started while `fn` runs. */
  async readsDuring<T>(fn: () => Promise<T>): Promise<Set<string>> {
    const sink = new Set<string>()
    state.readSinks.add(sink)
    try {
      await fn()
    } finally {
      state.readSinks.delete(sink)
    }
    return sink
  },
}

afterEach(() => {
  state.override = null
  const left = registryRecorder.take()
  if (left.length > 0) {
    throw new Error(left.map((v) => `registry write without bumpRegistryVersion: ${v.file}:${v.line} (${v.collection})`).join("\n"))
  }
})
