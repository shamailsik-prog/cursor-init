// Audit F10 (spec §2.3, §7): the write fence holds only if every Next Firestore write goes through the four helpers in
// platform/persistence/firestoreDbModular.ts. This static guard fails when a source file outside the allowed ones imports
// a Firestore SDK or reaches Firestore directly (a write that would bypass the fence), or when a helper stops consulting
// the fence.
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
const DIRECT_CALL = /\.(collection|collectionGroup|doc|runTransaction|batch|bulkWriter|recursiveDelete|listCollections)\s*\(/

/** The guard's verdict on one file. */
export function violations(rel: string, text: string): string[] {
  const out: string[] = []
  if (!SDK_ALLOWED.includes(rel) && SDK_IMPORT.test(codeOf(text))) out.push(`${rel}: imports a Firestore SDK`)
  if (!DIRECT_ALLOWED.includes(rel)) {
    const m = DIRECT_CALL.exec(codeOf(text, true))
    if (m) out.push(`${rel}: calls Firestore directly (.${m[1]}()) instead of through ${MODULAR}`)
  }
  return out
}

/** The exported functions of the helpers file that write, and whether each consults the fence. */
export function helperWriters(text: string): Array<{ name: string; consultsFence: boolean }> {
  const code = codeOf(text)
  const out: Array<{ name: string; consultsFence: boolean }> = []
  const starts = [...code.matchAll(/(?:^|\n)export (?:async )?function (\w+)/g)]
  for (const [i, m] of starts.entries()) {
    const body = code.slice(m.index!, starts[i + 1]?.index ?? code.length)
    if (/\.(set|update|delete|add|create|commit)\s*\(|client(Set|Update|Delete)Doc\(|clientRunTransaction\(/.test(body)) {
      out.push({ name: m[1]!, consultsFence: /\bfenceFor\(|\bwriteFence\(\)|refuseUnfencedClientWrite\(\)/.test(body) })
    }
  }
  return out
}

describe("F10: every Next Firestore write goes through the fenced helpers (static guard)", () => {
  it("the guard has teeth: a direct write, a Firestore SDK import, or an unfenced helper is caught", () => {
    expect(violations("platform/persistence/newRepo.ts", `import { getFirestore } from "firebase-admin/firestore"\n`)).toHaveLength(1)
    expect(violations("platform/persistence/newRepo.ts", `export async function save(db) {\n  await db.collection("matters").doc(id).set(row)\n}\n`)).toHaveLength(1)
    expect(violations("app/api/x/route.ts", `const { getFirestore } = await import("firebase-admin/firestore")\n`)).toHaveLength(1)
    // Prose and string contents do not count.
    expect(violations("platform/persistence/newRepo.ts", `// db.collection("x").doc("y").set({})\nconst s = "db.collection(x)"\n`)).toEqual([])
    const unfenced = `export async function setDoc(ref, data) {\n  await ref.set(data)\n}\n`
    expect(helperWriters(unfenced)).toEqual([{ name: "setDoc", consultsFence: false }])
  })

  it("no source outside the helpers imports a Firestore SDK or calls Firestore directly", () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap((rel) => violations(rel, readFileSync(path.join(ROOT, rel), "utf8")))
    expect(found).toEqual([])
  })

  it("every writing helper in firestoreDbModular consults the fence, and they are exactly the four fenced helpers", () => {
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
