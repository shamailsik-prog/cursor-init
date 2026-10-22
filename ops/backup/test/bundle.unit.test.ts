import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeKeyRing } from "../lib/envelope.mjs"
import { BundleWriter, openBundleFile, readBundleManifest, verifyBundle } from "../lib/bundle"
import { loadKeyRing } from "../lib/keys"

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "f33-bundle-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const MARKER = "PLAINTEXT-MARKER-F33-BUNDLE-0123456789"
const OPTS = { chunkExp: 10 }

async function makeBundle(key: Buffer, parent = root, store = "postgres-logical") {
  const writer = await BundleWriter.create(parent, store, key, OPTS)
  await writer.addBuffer("globals.sql", Buffer.from(`${MARKER} globals`))
  await writer.addStream("database.dump", Readable.from([Buffer.from(MARKER), randomBytes(5000)]))
  const dir = await writer.finish({ tables: { "public.t": { rows: 3 } } })
  return dir
}

function flipByte(file: string, index: number): void {
  const bytes = readFileSync(file)
  bytes[index] ^= 0x01
  writeFileSync(file, bytes)
}

function problemsText(r: { problems: string[] }): string {
  return r.problems.join("\n")
}

describe("bundle writer and verifier", () => {
  it("writes a verifiable bundle and returns its manifest and listing", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const dir = await makeBundle(key)
    const result = await verifyBundle(dir, ring)
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.bundle?.store).toBe("postgres-logical")
    expect(result.bundle?.files.map((f) => f.name).sort()).toEqual(["database.dump.skb", "globals.sql.skb", "manifest.json.skb"])
    expect(result.manifest).toMatchObject({ store: { tables: { "public.t": { rows: 3 } } } })
    expect(path.basename(dir)).toMatch(/^postgres-logical-\d{8}T\d{6}Z-[0-9a-f]{8}$/)
    expect(await readBundleManifest(dir, ring)).toEqual(result.manifest)
  })

  it("records each artefact's plaintext size and SHA-256 in the encrypted manifest", async () => {
    const key = randomBytes(32)
    const dir = await makeBundle(key)
    const manifest = (await verifyBundle(dir, makeKeyRing(key))).manifest as {
      artefacts: { name: string; plaintextBytes: number; plaintextSha256: string }[]
    }
    const globals = manifest.artefacts.find((a) => a.name === "globals.sql")!
    const expected = Buffer.from(`${MARKER} globals`)
    expect(globals.plaintextBytes).toBe(expected.length)
    expect(globals.plaintextSha256).toBe(createHash("sha256").update(expected).digest("hex"))
  })

  it("writes no plaintext file: no marker in any file of the bundle directory, and bundle.json is the only readable one", async () => {
    const key = randomBytes(32)
    const dir = await makeBundle(key)
    for (const name of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, name)).includes(Buffer.from(MARKER)), name).toBe(false)
    }
    expect(readdirSync(dir).filter((n) => !n.endsWith(".skb"))).toEqual(["bundle.json"])
  })

  it("opens an artefact as a decrypted stream", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const dir = await makeBundle(key)
    const parts: Buffer[] = []
    for await (const part of openBundleFile(dir, "globals.sql", ring)) parts.push(Buffer.from(part as Buffer))
    expect(Buffer.concat(parts).toString()).toBe(`${MARKER} globals`)
  })

  it("verifies with a previous key in the ring, and names the missing key otherwise", async () => {
    const oldKey = randomBytes(32)
    const dir = await makeBundle(oldKey)
    const rotated = makeKeyRing(randomBytes(32), [oldKey])
    expect((await verifyBundle(dir, rotated)).ok).toBe(true)
    const wrong = await verifyBundle(dir, makeKeyRing(randomBytes(32)))
    expect(wrong.ok).toBe(false)
    expect(problemsText(wrong)).toMatch(/UNKNOWN_KEY|not in the key ring/)
  })

  it("refuses one flipped byte in an artefact", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const dir = await makeBundle(key)
    flipByte(path.join(dir, "database.dump.skb"), 300)
    const result = await verifyBundle(dir, ring)
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toContain("database.dump.skb: ciphertext SHA-256 differs from bundle.json")
  })

  it("refuses a flipped byte even when bundle.json was edited to match the new ciphertext hash", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const dir = await makeBundle(key)
    const file = path.join(dir, "database.dump.skb")
    flipByte(file, 300)
    const info = JSON.parse(readFileSync(path.join(dir, "bundle.json"), "utf8"))
    const entry = info.files.find((f: { name: string }) => f.name === "database.dump.skb")
    entry.ciphertextSha256 = createHash("sha256").update(readFileSync(file)).digest("hex")
    writeFileSync(path.join(dir, "bundle.json"), JSON.stringify(info))
    const result = await verifyBundle(dir, ring)
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toMatch(/database\.dump\.skb: AUTH_FAILED/)
  })

  it("refuses a truncated artefact", async () => {
    const key = randomBytes(32)
    const dir = await makeBundle(key)
    const file = path.join(dir, "globals.sql.skb")
    writeFileSync(file, readFileSync(file).subarray(0, 60))
    const result = await verifyBundle(dir, makeKeyRing(key))
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toContain("globals.sql.skb")
  })

  it("refuses a missing artefact and an unlisted one", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const dir = await makeBundle(key)
    rmSync(path.join(dir, "globals.sql.skb"))
    expect(problemsText(await verifyBundle(dir, ring))).toContain("globals.sql.skb: missing")
    const dir2 = await makeBundle(key)
    writeFileSync(path.join(dir2, "extra.skb"), "x")
    expect(problemsText(await verifyBundle(dir2, ring))).toContain("extra.skb: not listed in bundle.json")
  })

  it("refuses a file swapped in from another bundle made with the same key (ciphertext hash)", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const a = await makeBundle(key, mkdtempSync(path.join(root, "a-")))
    const b = await makeBundle(key, mkdtempSync(path.join(root, "b-")))
    writeFileSync(path.join(a, "database.dump.skb"), readFileSync(path.join(b, "database.dump.skb")))
    const result = await verifyBundle(a, ring)
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toContain("database.dump.skb: ciphertext SHA-256 differs from bundle.json")
  })

  it("refuses the same swap when bundle.json was also fixed up: the plaintext hash in the encrypted manifest catches it", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const a = await makeBundle(key, mkdtempSync(path.join(root, "a-")))
    const b = await makeBundle(key, mkdtempSync(path.join(root, "b-")))
    const swapped = readFileSync(path.join(b, "database.dump.skb"))
    writeFileSync(path.join(a, "database.dump.skb"), swapped)
    const info = JSON.parse(readFileSync(path.join(a, "bundle.json"), "utf8"))
    const entry = info.files.find((f: { name: string }) => f.name === "database.dump.skb")
    entry.ciphertextSha256 = createHash("sha256").update(swapped).digest("hex")
    entry.ciphertextBytes = swapped.length
    writeFileSync(path.join(a, "bundle.json"), JSON.stringify(info))
    const result = await verifyBundle(a, ring)
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toContain("database.dump.skb: plaintext SHA-256 differs from the manifest")
  })

  it("refuses an edited manifest", async () => {
    const key = randomBytes(32)
    const dir = await makeBundle(key)
    flipByte(path.join(dir, "manifest.json.skb"), 100)
    const result = await verifyBundle(dir, makeKeyRing(key))
    expect(result.ok).toBe(false)
    expect(problemsText(result)).toMatch(/manifest\.json\.skb/)
  })

  it("refuses a directory without bundle.json (an interrupted writer leaves none)", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key, OPTS)
    await writer.addBuffer("globals.sql", Buffer.from("x"))
    const result = await verifyBundle(writer.dir, makeKeyRing(key))
    expect(result.ok).toBe(false)
    expect(existsSync(path.join(writer.dir, "bundle.json"))).toBe(false)
    expect(problemsText(result)).toContain("bundle.json: missing")
  })

  it("leaves no file under its final name when the source stream fails", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key, OPTS)
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"))
        this.destroy(new Error("source died"))
      },
    })
    await expect(writer.addStream("database.dump", failing)).rejects.toThrow("source died")
    expect(readdirSync(writer.dir)).toEqual([])
  })

  it("refuses artefact names that could escape the directory or shadow bundle.json, and duplicates", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "postgres-logical", key, OPTS)
    for (const bad of ["../x", "a/b", "bundle.json", "manifest.json", "", ".hidden"]) {
      await expect(writer.addBuffer(bad, Buffer.from("x")), bad).rejects.toThrow(/artefact name/)
    }
    await writer.addBuffer("ok", Buffer.from("x"))
    await expect(writer.addBuffer("ok", Buffer.from("y"))).rejects.toThrow(/already/)
  })

  it("verifies an empty artefact", async () => {
    const key = randomBytes(32)
    const writer = await BundleWriter.create(root, "firestore-emulator", key, OPTS)
    await writer.addBuffer("empty", Buffer.alloc(0))
    const dir = await writer.finish({})
    expect((await verifyBundle(dir, makeKeyRing(key))).problems).toEqual([])
  })
})

describe("loadKeyRing", () => {
  const hex = () => randomBytes(32).toString("hex")

  it("reads the current key from SIKANDER_BACKUP_KEY and previous keys from SIKANDER_BACKUP_PREVIOUS_KEYS", () => {
    const current = hex()
    const previous = [hex(), hex()]
    const ring = loadKeyRing({
      env: { SIKANDER_BACKUP_KEY: current, SIKANDER_BACKUP_PREVIOUS_KEYS: previous.join(",") },
    })
    expect(ring.current.toString("hex")).toBe(current)
    expect(ring.byId.size).toBe(3)
  })

  it("reads the key from a file whose mode is 0600", () => {
    const file = path.join(root, "backup.key")
    const value = hex()
    writeFileSync(file, `${value}\n`)
    chmodSync(file, 0o600)
    expect(loadKeyRing({ env: {}, keyFile: file }).current.toString("hex")).toBe(value)
  })

  it("refuses a key file readable by group or others", () => {
    const file = path.join(root, "backup.key")
    writeFileSync(file, hex())
    chmodSync(file, 0o644)
    expect(() => loadKeyRing({ env: {}, keyFile: file })).toThrow(/mode/)
  })

  it("refuses when both a key and a key file are given, and when neither is", () => {
    const file = path.join(root, "backup.key")
    writeFileSync(file, hex())
    chmodSync(file, 0o600)
    expect(() => loadKeyRing({ env: { SIKANDER_BACKUP_KEY: hex() }, keyFile: file })).toThrow(/both/)
    expect(() => loadKeyRing({ env: {} })).toThrow(/no backup key/)
  })

  it("refuses a bad previous key without echoing it", () => {
    const bad = "ab".repeat(32)
    expect(() => loadKeyRing({ env: { SIKANDER_BACKUP_KEY: hex(), SIKANDER_BACKUP_PREVIOUS_KEYS: bad } })).toThrow(/previous/)
    try {
      loadKeyRing({ env: { SIKANDER_BACKUP_KEY: hex(), SIKANDER_BACKUP_PREVIOUS_KEYS: bad } })
    } catch (err) {
      expect((err as Error).message).not.toContain(bad)
    }
  })
})
