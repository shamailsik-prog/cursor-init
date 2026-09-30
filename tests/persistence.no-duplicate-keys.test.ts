import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { WORKFLOW_OPS_DENY_BY_DEFAULT_FIRESTORE_COLLECTION_BY_SPINE_KEY } from "@/platform/persistence/denyByDefaultWorkflowOpsRepository"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { newStore } from "@/platform/spine/store"

/**
 * Regression guard: duplicate object keys / interface members / type aliases in the
 * repository layer silently overwrite each other (the later definition wins at runtime,
 * TS1117/TS2300 at compile time). Keep these files duplicate-free.
 */
const FILES = [
  "platform/persistence/spineRepositories.ts",
  "platform/persistence/firestoreSpineRepositories.ts",
  "platform/persistence/denyByDefaultWorkflowOpsRepository.ts",
  "platform/spine/store.ts",
]

function duplicateNames(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const check = (kind: string, members: readonly ts.Node[]) => {
    const seen = new Set<string>()
    for (const member of members) {
      const name = (member as { name?: ts.Node }).name
      if (!name) continue
      const text = name.getText(src)
      if (seen.has(text)) {
        const line = src.getLineAndCharacterOfPosition(member.getStart()).line + 1
        found.push(`${file}:${line} ${kind} ${text.slice(-80)}`)
      }
      seen.add(text)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      check("property", node.properties.filter((p) => !ts.isSpreadAssignment(p)))
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      check("member", node.members)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  check(
    "type",
    src.statements.filter((s) => ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s))
  )
  return found
}

describe("repository layer has no duplicate keys", () => {
  for (const file of FILES) {
    it(`${file} declares every key once`, () => {
      expect(duplicateNames(file)).toEqual([])
    })
  }

  it("memory and Firestore adapters expose the same repository keys", () => {
    const memoryKeys = Object.keys(createMemoryRepositories(newStore())).sort()
    const firestoreKeys = Object.keys(
      createFirestoreRepositories({} as Parameters<typeof createFirestoreRepositories>[0])
    ).sort()
    expect(firestoreKeys).toEqual(memoryKeys)
  })

  it("every deny-by-default spine key is a real repository key", () => {
    const memoryKeys = new Set(Object.keys(createMemoryRepositories(newStore())))
    const unknown = Object.keys(WORKFLOW_OPS_DENY_BY_DEFAULT_FIRESTORE_COLLECTION_BY_SPINE_KEY).filter(
      (key) => !memoryKeys.has(key)
    )
    expect(unknown).toEqual([])
  })
})
