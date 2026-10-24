import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PG_LINK_CHECKS } from "../postgres/links"

const DDL_ROOT = path.resolve(__dirname, "../../../postgres/ddl")

function ddlText(): string {
  const files = ["001_corpus_contract.sql", "003_corpus_publication.sql", "004_authority_read_views.sql"]
  return files.map((f) => readFileSync(path.join(DDL_ROOT, f), "utf8")).join("\n")
}

function tableColumnMentioned(ddl: string, table: string, column?: string): boolean {
  const tableRe = new RegExp(`\\b${table}\\b`, "i")
  if (!tableRe.test(ddl)) return false
  if (!column) return true
  return new RegExp(`\\b${table}\\b[^;]*\\b${column}\\b`, "i").test(ddl) || ddl.includes(`${table}.${column}`)
}

describe("postgres link SQL", () => {
  const ddl = ddlText()

  it("names only existing tables from scraper models or annex A DDL", () => {
    const scraperModels = readFileSync(
      path.resolve(__dirname, "../../../corpus_service/scraper/models.py"),
      "utf8"
    )
    for (const check of PG_LINK_CHECKS) {
      for (const table of check.tables) {
        const inDdl = ddl.includes(table)
        const inModels = scraperModels.includes(`"${table}"`) || scraperModels.includes(`'${table}'`)
        expect(inDdl || inModels, `${check.name} references unknown table ${table}`).toBe(true)
      }
    }
  })

  it("parses as a single SELECT count statement per check", () => {
    for (const check of PG_LINK_CHECKS) {
      expect(check.sql.trim().toLowerCase()).toMatch(/^select count\(\*\)/)
      expect(check.sql).not.toMatch(/;.*select/i)
    }
  })
})
