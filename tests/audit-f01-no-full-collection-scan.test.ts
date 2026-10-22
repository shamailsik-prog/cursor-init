import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"

const PERSISTENCE_ROOT = join(process.cwd(), "platform/persistence")
const MODULAR_ONLY = join(PERSISTENCE_ROOT, "firestoreDbModular.ts")

const COLLECTION_CALL_PATTERNS: RegExp[] = [/\bcollection\s*\(/, /\.collection\s*\(/]

function listPersistenceSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full)
    }
  }
  walk(PERSISTENCE_ROOT)
  return out.filter((file) => file !== MODULAR_ONLY)
}

function scanCollectionCalls(paths: string[]): string[] {
  const hits: string[] = []
  for (const file of paths) {
    const rel = relative(process.cwd(), file)
    const text = readFileSync(file, "utf8")
    for (const re of COLLECTION_CALL_PATTERNS) {
      if (re.test(text)) hits.push(`${rel}: ${re}`)
    }
  }
  return hits
}

function writeSeededFixture(dir: string, fileName: string, body: string): string {
  const relRoot = join(dir, "platform/persistence")
  mkdirSync(relRoot, { recursive: true })
  const bad = join(relRoot, fileName)
  writeFileSync(bad, body, "utf8")
  return bad
}

describe("FA-F01-001 no admin full-collection scans", () => {
  it("static scan: no collection() / .collection() outside firestoreDbModular.ts", () => {
    const hits = scanCollectionCalls(listPersistenceSources())
    expect(hits).toEqual([])
  })

  it("seeded: getDocs(collection(db, ...)) is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-f01-scan-"))
    const bad = writeSeededFixture(
      dir,
      "evil-getdocs-collection.ts",
      "import { collection, getDocs } from './firestoreDbModular'\nawait getDocs(collection(db, 'matters'))\n"
    )
    expect(scanCollectionCalls([bad])).not.toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it("seeded: admin .collection(...).get() is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-f01-scan-"))
    const bad = writeSeededFixture(
      dir,
      "evil-admin-get.ts",
      "const x = db.collection('matters').get()\n"
    )
    expect(scanCollectionCalls([bad])).not.toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it("seeded: variable collection ref .get() is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-f01-scan-"))
    const bad = writeSeededFixture(
      dir,
      "evil-col-var.ts",
      "const col = db.collection('matters')\nawait col.get()\n"
    )
    expect(scanCollectionCalls([bad])).not.toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it("seeded: disguised query variable with collection() is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-f01-scan-"))
    const bad = writeSeededFixture(
      dir,
      "evil-query-var.ts",
      "const query = collection(db, 'matters')\nawait getDocs(query)\n"
    )
    expect(scanCollectionCalls([bad])).not.toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it("behavioural: two firms — listByFirm only returns the scoped firm", async () => {
    // Audit F13: canonical matter rows (the shared validator never returns a partial one).
    const docs: Record<string, { id: string; firmId: string; title: string } & Record<string, string>> = {
      mA: { id: "mA", firmId: "firmA", title: "A", clientId: "c", status: "live", classification: "internal" },
      mB: { id: "mB", firmId: "firmB", title: "B", clientId: "c", status: "live", classification: "internal" },
    }
    const db = {
      collection: (_name: string) => ({
        doc: (id: string) => ({
          get: async () => ({
            exists: Boolean(docs[id]),
            data: () => docs[id],
          }),
        }),
        where: (field: string, _op: string, value: string) => ({
          limit: (_n: number) => ({
            get: async () => ({
              docs: Object.values(docs)
                .filter((row) => row[field as keyof typeof row] === value)
                .map((row) => ({ id: row.id, data: () => row })),
              empty: false,
            }),
          }),
        }),
      }),
    }
    const repos = createFirestoreRepositories(db as never)
    const firmA = await repos.matters.listByFirm("firmA")
    expect(firmA.map((r) => r.id)).toEqual(["mA"])
    expect(await repos.matters.get("mB", "firmA")).toBeNull()
  })
})
