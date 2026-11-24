import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http/errors"
import { assertLooseVaultEnabled, isLooseVaultEnabled } from "../src/d1/looseVault/flag"

/**
 * Module-shape tests for the loose vault (L4.5 / E-18). They do not touch Firestore.
 * The env name is hardcoded so a rename of the flag constant cannot hide a miss.
 */
const FLAG = "SIKANDER_FLAG_L4_LOOSE_VAULT"
const DIR = path.resolve(__dirname, "../src/d1/looseVault")

const saved = process.env[FLAG]
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
})

describe("loose vault flag", () => {
  it("is off unless the env value is exactly true after trim", () => {
    delete process.env[FLAG]
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = ""
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = "false"
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = "yes"
    expect(isLooseVaultEnabled()).toBe(false)
    process.env[FLAG] = " TRUE "
    expect(isLooseVaultEnabled()).toBe(true)
    delete process.env[FLAG]
    expect(() => assertLooseVaultEnabled()).toThrow(HttpError)
    try {
      assertLooseVaultEnabled()
    } catch (err) {
      expect(err).toMatchObject({ status: 404, code: "feature_disabled" })
    }
  })
})

describe("loose vault source", () => {
  it("has no delete path in the module", () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith(".ts"))
    expect(files).toEqual(expect.arrayContaining(["tags.ts", "search.ts", "convert.ts", "escalation.ts", "flag.ts"]))
    for (const name of files) {
      const src = readFileSync(path.join(DIR, name), "utf8")
      expect(src.includes(".delete("), name).toBe(false)
      expect(src.includes("recursiveDelete"), name).toBe(false)
    }
  })

  it("convert never writes a null matterId", () => {
    const src = readFileSync(path.join(DIR, "convert.ts"), "utf8")
    expect(src).not.toMatch(/matterId:\s*null/)
  })

  it("records the per-uploader upload-block reading and that nothing is deleted", () => {
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8")
    expect(readme.toLowerCase()).toContain("per uploader")
    expect(readme.toLowerCase()).toContain("never delet")
    expect(readme).toContain("SIKANDER_FLAG_L4_LOOSE_VAULT")
  })

  it("queries loose rows in Firestore, and the upload block also names the uploader", () => {
    const flag = readFileSync(path.join(DIR, "flag.ts"), "utf8")
    expect(flag).toContain('.where("firmId", "==", firmId)')
    expect(flag).toContain('.where("matterId", "==", null)')
    expect(flag).toContain('.where("uploadedBy", "==", uploaderId)')
    expect(flag).toContain("orderBy(FieldPath.documentId())")
    expect(flag).toContain("startAfter")
    expect(flag).not.toContain("firmDocumentDocs")
    const search = readFileSync(path.join(DIR, "search.ts"), "utf8")
    const escalation = readFileSync(path.join(DIR, "escalation.ts"), "utf8")
    expect(search).toContain("looseFirmDocs")
    expect(search).not.toContain("firmDocumentDocs")
    expect(escalation).toContain("looseFirmDocs")
    expect(escalation).toContain("looseUploaderDocs")
    expect(escalation).not.toContain("firmDocumentDocs")
  })

  it("binds a partner acknowledgement to the caller and audits it", () => {
    const escalation = readFileSync(path.join(DIR, "escalation.ts"), "utf8")
    expect(escalation).toContain("partnerId: actor.uid")
    expect(escalation).toContain('action: "loose_vault.acknowledge"')
  })

  it("locks loosePartnerAck, createdAt and uploadedBy against client writes", () => {
    const rules = readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8")
    const block = rules.slice(rules.indexOf("match /documents/{docId}"))
    expect(block.startsWith("match /documents/{docId}")).toBe(true)
    const update = block.slice(block.indexOf("allow update"), block.indexOf("allow delete"))
    expect(update).toContain("'loosePartnerAck'")
    expect(update).toContain("'createdAt'")
    expect(update).toContain("'uploadedBy'")
    expect(rules).toContain("uploadedBy == request.auth.uid")
    expect(rules).toContain("createdAt == request.time")
    expect(rules).toContain("noClientLooseAck()")
  })
})
