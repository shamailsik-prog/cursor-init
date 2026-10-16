// Audit F10 (spec §2.3, §7): the write fence holds only if every Next Firestore write goes through the four helpers in
// platform/persistence/firestoreDbModular.ts. This is a static, text-level guard over the non-test sources in app/,
// platform/, lib/, services/ and components/.
//
// It fails when a file outside the allowed ones:
// - imports a Firestore SDK;
// - requires or imports a module by a computed (non-literal) name;
// - obtains the Firestore handle (getRuntimeFirestore, getProductionFirestore);
// - calls the Firestore API by name (`.collection(`, `.doc(`, `.runTransaction(`, `.batch(`, …);
// - reaches a Firestore member by bracket access (`["collection"]`, `["set"]`, …);
// - writes through a ref taken from the helpers' `doc()` / `collection()` (`ref.set(`, `doc(…).update(`, …).
//
// It also fails when one of the four writing helpers stops taking its fence (`fenceFor(ref)` / `writeFence()`).
// Re-audit of 08c0990, LOW-3: the auditor's bypass forms are must-fail samples below.
//
// What it does not see: a handle obtained some other way and passed in, or aliasing beyond one assignment. The
// behaviour tests (tests/f10-*.firestore.test.ts) are what prove the fence itself; this guard keeps new code on it.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "..")
const SOURCE_DIRS = ["app", "platform", "lib", "services", "components"]
const MODULAR = "platform/persistence/firestoreDbModular.ts"
/** May import a Firestore SDK: the helpers, and the Admin initialisation. */
const SDK_ALLOWED = [MODULAR, "platform/persistence/adminFirestore.ts"]
/** May call the Firestore API directly: the above, and the durable idempotency store (its own two collections only). */
const DIRECT_ALLOWED = [...SDK_ALLOWED, "platform/http/durableIdempotency.ts"]
/** May obtain the Firestore handle: where it is made, the repositories' selector, and the idempotency store's owner. */
const HANDLE_ALLOWED = ["platform/persistence/adminFirestore.ts", "platform/persistence/runtimeRepositories.ts", "platform/http/idempotency.ts"]
const FENCED_HELPERS = ["setDoc", "updateDoc", "deleteDoc", "runTransaction"]

function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`
      if (name === "node_modules" || name.startsWith(".")) continue
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(rel)
    }
  }
  for (const dir of SOURCE_DIRS) walk(dir)
  return out
}

/** Code with comments blanked (and, with `strings`, string and template contents too), so prose and literals never match. */
function codeOf(text: string, strings = false): string {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, (m, p: string) => p + " ".repeat(m.length - p.length))
  if (!strings) return noComments
  return noComments.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, " ") + m[0])
}

const SDK_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:firebase-admin(?:\/firestore)?|firebase\/firestore|@firebase\/firestore|@google-cloud\/firestore)["']/
const COMPUTED_MODULE = /(?<![\w$.])(?:require|import)\s*\(\s*(?!["'])[^\s)]/
const HANDLE = /\b(getRuntimeFirestore|getProductionFirestore)\b/
const DIRECT_CALL = /\.(collection|collectionGroup|doc|runTransaction|batch|bulkWriter|recursiveDelete|listCollections)\s*\(/
const FIRESTORE_MEMBERS = "collection|collectionGroup|doc|runTransaction|batch|bulkWriter|recursiveDelete|listCollections|set|update|delete|create|add|commit"
const BRACKET_ACCESS = new RegExp(`[\\w$)\\]]\\s*\\[\\s*["'\`](${FIRESTORE_MEMBERS})["'\`]\\s*\\]`)
const WRITE = "set|update|delete|create|add"
/** `doc(…).set(` / `collection(…).add(` inline (one level of nested parentheses inside the call). */
const INLINE_HELPER_WRITE = new RegExp(`(?<![\\w$.])(?:doc|collection)\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.\\s*(${WRITE})\\s*\\(`)
/** `const ref = doc(…)` / `let c = await collection(…)`: the names that hold a ref taken from a helper. */
const HELPER_REF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:doc|collection)\s*\(/g

/** The guard's verdict on one file (spec §7). */
export function violations(rel: string, text: string): string[] {
  const out: string[] = []
  const plain = codeOf(text)
  const blank = codeOf(text, true)
  if (!SDK_ALLOWED.includes(rel) && SDK_IMPORT.test(plain)) out.push(`${rel}: imports a Firestore SDK`)
  if (COMPUTED_MODULE.test(plain)) out.push(`${rel}: requires or imports a module by a computed name`)
  if (!HANDLE_ALLOWED.includes(rel)) {
    const m = HANDLE.exec(blank)
    if (m) out.push(`${rel}: obtains the Firestore handle (${m[1]})`)
  }
  if (!DIRECT_ALLOWED.includes(rel)) {
    const m = DIRECT_CALL.exec(blank)
    if (m) out.push(`${rel}: calls Firestore directly (.${m[1]}()) instead of through ${MODULAR}`)
    const b = BRACKET_ACCESS.exec(plain)
    if (b) out.push(`${rel}: reaches a Firestore member by bracket access (["${b[1]}"])`)
    const inline = INLINE_HELPER_WRITE.exec(blank)
    if (inline) out.push(`${rel}: writes through a helper ref (.${inline[1]}()) instead of setDoc/updateDoc/deleteDoc/runTransaction`)
    for (const [, name] of blank.matchAll(HELPER_REF)) {
      const w = new RegExp(`(?<![\\w$.])${name!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\.\\s*(${WRITE})\\s*\\(`).exec(blank)
      if (w) out.push(`${rel}: writes through a helper ref (${name}.${w[1]}()) instead of setDoc/updateDoc/deleteDoc/runTransaction`)
    }
  }
  return out
}

/**
 * The exported functions of the helpers file that write, and whether each takes its fence: setDoc, updateDoc and
 * deleteDoc must assign `fenceFor(ref)` and branch on it; runTransaction must assign `writeFence()` and branch on it.
 */
export function helperWriters(text: string): Array<{ name: string; consultsFence: boolean }> {
  const code = codeOf(text)
  const out: Array<{ name: string; consultsFence: boolean }> = []
  const starts = [...code.matchAll(/(?:^|\n)export (?:async )?function (\w+)/g)]
  for (const [i, m] of starts.entries()) {
    const body = code.slice(m.index!, starts[i + 1]?.index ?? code.length)
    if (/\.(set|update|delete|add|create|commit)\s*\(|client(Set|Update|Delete)Doc\(|clientRunTransaction\(/.test(body)) {
      const takesFence = /\bconst fence = (?:fenceFor\(ref\)|writeFence\(\))\s*\n\s*if \(fence\)/.test(body)
      out.push({ name: m[1]!, consultsFence: takesFence })
    }
  }
  return out
}

describe("F10: every Next Firestore write goes through the fenced helpers (static guard)", () => {
  const repo = "platform/persistence/newRepo.ts"

  it("the guard has teeth: a direct write, a Firestore SDK import, or an unfenced helper is caught", () => {
    expect(violations(repo, `import { getFirestore } from "firebase-admin/firestore"\n`)).toHaveLength(1)
    expect(violations(repo, `export async function save(db) {\n  await db.collection("matters").doc(id).set(row)\n}\n`)).toHaveLength(1)
    expect(violations("app/api/x/route.ts", `const { getFirestore } = await import("firebase-admin/firestore")\n`)).toHaveLength(1)
    // Prose and string contents do not count.
    expect(violations(repo, `// db.collection("x").doc("y").set({})\nconst s = "db.collection(x)"\n`)).toEqual([])
    const unfenced = `export async function setDoc(ref, data) {\n  await ref.set(data)\n}\n`
    expect(helperWriters(unfenced)).toEqual([{ name: "setDoc", consultsFence: false }])
  })

  it("re-audit LOW-3: the auditor's bypass forms are caught", () => {
    const forms: Record<string, string> = {
      helperDocThenRawSet: `import { doc } from "@/platform/persistence/firestoreDbModular"\nexport async function save(db, row) {\n  const ref = doc(db, "matters", row.id)\n  await ref.set(row)\n}\n`,
      helperDocInlineUpdate: `import { doc } from "@/platform/persistence/firestoreDbModular"\nexport async function bump(db, id) {\n  await doc(db, "matters", id).update({ n: 1 })\n}\n`,
      helperCollectionAdd: `import { collection } from "@/platform/persistence/firestoreDbModular"\nexport async function log(db, row) {\n  const events = collection(db, "events")\n  await events.add(row)\n}\n`,
      bracketCollection: `export async function save(db, row) {\n  await db["collection"]("matters")["doc"](row.id)["set"](row)\n}\n`,
      dynamicRequire: `const m = "firebase-admin/" + "firestore"\nexport const sdk = require(m)\n`,
      dynamicImport: `export const load = (name: string) => import(name)\n`,
      runtimeFirestoreHandle: `import { getRuntimeFirestore } from "@/platform/persistence/runtimeRepositories"\nexport async function save(row) {\n  const db: any = await getRuntimeFirestore()\n  const c = db.collection\n  await c.call(db, "matters").doc(row.id).set(row)\n}\n`,
    }
    const caught = Object.fromEntries(Object.entries(forms).map(([k, src]) => [k, violations(repo, src).length > 0]))
    expect(caught).toEqual(Object.fromEntries(Object.keys(forms).map((k) => [k, true])))
    // Reads through a helper ref, and Map/Set writes, are not writes to Firestore.
    expect(violations(repo, `import { doc, getDoc } from "@/platform/persistence/firestoreDbModular"\nexport async function load(db, id) {\n  const ref = doc(db, "matters", id)\n  const seen = new Map()\n  seen.set(id, true)\n  return getDoc(ref)\n}\n`)).toEqual([])
    // An array argument is not bracket access.
    expect(violations(repo, `export const gate = only(["create", "set"])\n`)).toEqual([])
  })

  it("re-audit LOW-3: a helper whose fence lookup is removed is reported as not taking its fence", () => {
    const modular = readFileSync(path.join(ROOT, MODULAR), "utf8")
    const mutated = modular.replace(
      "    const fence = fenceFor(ref)\n    if (fence) {\n      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {\n        note(ref.path)\n        tx.set(",
      "    const fence = null as WriteFence | null\n    if (fence) {\n      await fence.transact((ref as unknown as AdminStyleRef).firestore, async (tx, note) => {\n        note(ref.path)\n        tx.set("
    )
    expect(mutated).not.toBe(modular)
    expect(helperWriters(mutated).filter((w) => !w.consultsFence).map((w) => w.name)).toEqual(["setDoc"])
    const noTxFence = modular.replace("    const fence = writeFence()\n    if (fence) return fence.transact(", "    const fence = null as WriteFence | null\n    if (fence) return fence.transact(")
    expect(noTxFence).not.toBe(modular)
    expect(helperWriters(noTxFence).filter((w) => !w.consultsFence).map((w) => w.name)).toEqual(["runTransaction"])
  })

  it("no source outside the helpers imports a Firestore SDK, obtains the handle, or reaches Firestore other than through them", () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap((rel) => violations(rel, readFileSync(path.join(ROOT, rel), "utf8")))
    expect(found).toEqual([])
  })

  it("every writing helper in firestoreDbModular takes its fence, and they are exactly the four fenced helpers", () => {
    const writers = helperWriters(readFileSync(path.join(ROOT, MODULAR), "utf8"))
    expect(writers.map((w) => w.name).sort()).toEqual([...FENCED_HELPERS].sort())
    expect(writers.filter((w) => !w.consultsFence)).toEqual([])
  })

  it("the durable idempotency store reaches only its own two collections", () => {
    const code = codeOf(readFileSync(path.join(ROOT, "platform/http/durableIdempotency.ts"), "utf8"))
    const targets = [...code.matchAll(/\.collection\(\s*([^)]*)\)/g)].map((m) => m[1]!.trim())
    expect(targets.length).toBeGreaterThan(0)
    expect([...new Set(targets)].sort()).toEqual(["EFFECTS_COLLECTION", "KEYS_COLLECTION"])
  })
})
