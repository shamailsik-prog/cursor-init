import { createHash, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { Readable, Transform, Writable, pipeline as pipelineWithCallback } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  EnvelopeError,
  createDecryptStream,
  createEncryptStream,
  keyIdOf,
  type KeyRing,
} from "./envelope.mjs"

export const BUNDLE_FORMAT = "sikander-backup-bundle/1"
export const BUNDLE_FILE = "bundle.json"
export const MANIFEST_NAME = "manifest.json"
export const TOOL_VERSION = "f33-1"
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type BundleFileInfo = { name: string; ciphertextBytes: number; ciphertextSha256: string }
export type BundleInfo = {
  format: typeof BUNDLE_FORMAT
  store: string
  createdAt: string
  toolVersion: string
  keyId: string
  files: BundleFileInfo[]
}
export type ArtefactInfo = { name: string; plaintextBytes: number; plaintextSha256: string }
/** What manifest.json.skb holds: the artefacts' plaintext facts and the store's own manifest (spec R5). */
export type BundleManifest<T = unknown> = { artefacts: ArtefactInfo[]; store: T }

/** A pass-through that counts bytes and hashes them. */
function tap(): { stream: Transform; result: () => { bytes: number; sha256: string } } {
  const hash = createHash("sha256")
  let bytes = 0
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      bytes += chunk.length
      cb(null, chunk)
    },
  })
  return { stream, result: () => ({ bytes, sha256: hash.copy().digest("hex") }) }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fsp.open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}

/**
 * Writes a bundle (spec R5): every artefact is encrypted as it streams in (no plaintext file exists), written
 * under a temporary name and renamed; `finish` writes manifest.json.skb and then bundle.json, last, so a
 * directory without bundle.json is an interrupted backup and never verifies.
 */
export class BundleWriter {
  readonly dir: string
  private readonly files: BundleFileInfo[] = []
  private readonly artefacts: ArtefactInfo[] = []
  private finished = false

  private constructor(
    dir: string,
    private readonly store: string,
    private readonly key: Buffer,
    private readonly chunkExp: number | undefined,
    private readonly createdAt: Date
  ) {
    this.dir = dir
  }

  static async create(
    root: string,
    store: string,
    key: Buffer,
    opts: { chunkExp?: number; now?: Date } = {}
  ): Promise<BundleWriter> {
    if (!NAME_RE.test(store)) throw new Error(`bundle store name ${JSON.stringify(store)} is not a plain name`)
    keyIdOf(key) // validates the key before anything is created
    const now = opts.now ?? new Date()
    const dir = path.join(root, `${store}-${stamp(now)}-${randomBytes(4).toString("hex")}`)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    return new BundleWriter(dir, store, key, opts.chunkExp, now)
  }

  private claim(name: string): void {
    if (!NAME_RE.test(name) || name === MANIFEST_NAME || name === BUNDLE_FILE) {
      throw new Error(`artefact name ${JSON.stringify(name)} is not allowed`)
    }
    if (this.artefacts.some((a) => a.name === name)) throw new Error(`artefact ${name} was already added`)
  }

  async addBuffer(name: string, data: Buffer): Promise<void> {
    await this.addStream(name, Readable.from([data]))
  }

  async addStream(name: string, source: Readable): Promise<void> {
    if (this.finished) throw new Error("the bundle is finished")
    this.claim(name)
    const info = await this.seal(`${name}.skb`, source)
    this.artefacts.push({ name, plaintextBytes: info.plain.bytes, plaintextSha256: info.plain.sha256 })
    this.files.push({ name: `${name}.skb`, ciphertextBytes: info.cipher.bytes, ciphertextSha256: info.cipher.sha256 })
  }

  private async seal(fileName: string, source: Readable) {
    const final = path.join(this.dir, fileName)
    const temp = `${final}.part`
    const plain = tap()
    const cipher = tap()
    try {
      await pipeline(
        source,
        plain.stream,
        createEncryptStream(this.key, this.chunkExp === undefined ? {} : { chunkExp: this.chunkExp }),
        cipher.stream,
        createWriteStream(temp, { flags: "wx", mode: 0o600 })
      )
      const synced = await fsp.open(temp, "r+")
      try {
        await synced.sync()
      } finally {
        await synced.close()
      }
    } catch (err) {
      await fsp.rm(temp, { force: true })
      throw err
    }
    await fsp.rename(temp, final)
    return { plain: plain.result(), cipher: cipher.result() }
  }

  async finish(storeManifest: unknown): Promise<string> {
    if (this.finished) throw new Error("the bundle is finished")
    const manifest: BundleManifest = { artefacts: [...this.artefacts], store: storeManifest }
    const body = Buffer.from(JSON.stringify(manifest))
    const info = await this.seal(`${MANIFEST_NAME}.skb`, Readable.from([body]))
    this.files.push({ name: `${MANIFEST_NAME}.skb`, ciphertextBytes: info.cipher.bytes, ciphertextSha256: info.cipher.sha256 })
    const bundle: BundleInfo = {
      format: BUNDLE_FORMAT,
      store: this.store,
      createdAt: this.createdAt.toISOString(),
      toolVersion: TOOL_VERSION,
      keyId: keyIdOf(this.key),
      files: [...this.files].sort((a, b) => a.name.localeCompare(b.name)),
    }
    const temp = path.join(this.dir, `${BUNDLE_FILE}.part`)
    await fsp.writeFile(temp, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 })
    await fsp.rename(temp, path.join(this.dir, BUNDLE_FILE))
    await syncDir(this.dir)
    this.finished = true
    return this.dir
  }
}

export type VerifyResult = { ok: boolean; problems: string[]; bundle?: BundleInfo; manifest?: BundleManifest }

async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { bytes, sha256: hash.digest("hex") }
}

function describe(err: unknown): string {
  return err instanceof EnvelopeError ? `${err.code} (${err.message})` : String((err as Error)?.message ?? err)
}

/** Decrypts one file, returning the plaintext size and hash; throws EnvelopeError on any refusal. */
async function plaintextFacts(file: string, ring: KeyRing) {
  const plain = tap()
  const sink = new Writable({ write: (_chunk, _enc, cb) => cb() })
  await pipeline(createReadStream(file), createDecryptStream(ring), plain.stream, sink)
  return plain.result()
}

/**
 * Checks a bundle without restoring anything (spec R5): the listing, every ciphertext hash, the authentication
 * of every chunk of every file, and every plaintext hash against the encrypted manifest.
 */
export async function verifyBundle(dir: string, ring: KeyRing): Promise<VerifyResult> {
  const problems: string[] = []
  let bundle: BundleInfo
  try {
    bundle = JSON.parse(await fsp.readFile(path.join(dir, BUNDLE_FILE), "utf8")) as BundleInfo
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT"
    return { ok: false, problems: [missing ? `${BUNDLE_FILE}: missing (an interrupted backup writes none)` : `${BUNDLE_FILE}: unreadable (${describe(err)})`] }
  }
  if (bundle.format !== BUNDLE_FORMAT || !Array.isArray(bundle.files)) {
    return { ok: false, problems: [`${BUNDLE_FILE}: unsupported format ${JSON.stringify(bundle.format)}`] }
  }
  if (!ring.byId.has(bundle.keyId)) {
    problems.push(`${BUNDLE_FILE}: UNKNOWN_KEY (made with key ${bundle.keyId}, which is not in the key ring)`)
    return { ok: false, problems, bundle }
  }

  const listed = new Map(bundle.files.map((f) => [f.name, f]))
  for (const name of await fsp.readdir(dir)) {
    if (name === BUNDLE_FILE) continue
    if (!listed.has(name)) problems.push(`${name}: not listed in ${BUNDLE_FILE}`)
  }

  const present: string[] = []
  for (const info of bundle.files) {
    const file = path.join(dir, info.name)
    let facts
    try {
      facts = await hashFile(file)
    } catch {
      problems.push(`${info.name}: missing`)
      continue
    }
    present.push(info.name)
    if (facts.sha256 !== info.ciphertextSha256 || facts.bytes !== info.ciphertextBytes) {
      problems.push(`${info.name}: ciphertext SHA-256 differs from ${BUNDLE_FILE}`)
    }
  }

  let manifest: BundleManifest | undefined
  if (present.includes(`${MANIFEST_NAME}.skb`)) {
    try {
      manifest = await readBundleManifest(dir, ring)
    } catch (err) {
      problems.push(`${MANIFEST_NAME}.skb: ${describe(err)}`)
    }
  } else if (!problems.some((p) => p.startsWith(`${MANIFEST_NAME}.skb`))) {
    problems.push(`${MANIFEST_NAME}.skb: missing`)
  }

  const artefacts = new Map((manifest?.artefacts ?? []).map((a) => [`${a.name}.skb`, a]))
  for (const name of present) {
    if (name === `${MANIFEST_NAME}.skb`) continue
    let facts
    try {
      facts = await plaintextFacts(path.join(dir, name), ring)
    } catch (err) {
      problems.push(`${name}: ${describe(err)}`)
      continue
    }
    const expected = artefacts.get(name)
    if (manifest && !expected) {
      problems.push(`${name}: not in the manifest`)
    } else if (expected && (expected.plaintextSha256 !== facts.sha256 || expected.plaintextBytes !== facts.bytes)) {
      problems.push(`${name}: plaintext SHA-256 differs from the manifest`)
    }
  }
  if (manifest) {
    for (const name of artefacts.keys()) {
      if (!listed.has(name)) problems.push(`${name}: in the manifest but not listed in ${BUNDLE_FILE}`)
    }
  }
  return { ok: problems.length === 0, problems, bundle, manifest }
}

/** The decrypted manifest.json.skb; throws EnvelopeError when it does not authenticate. */
export async function readBundleManifest(dir: string, ring: KeyRing): Promise<BundleManifest> {
  const parts: Buffer[] = []
  await pipeline(createReadStream(path.join(dir, `${MANIFEST_NAME}.skb`)), createDecryptStream(ring), async (source) => {
    for await (const part of source) parts.push(Buffer.from(part as Buffer))
  })
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as BundleManifest
}

/**
 * One artefact as a decrypted stream. Pass `expect` (from the verified manifest) and the stream errors at its
 * end when the plaintext hash or size differs, so a restore never uses a file that is not the one backed up.
 */
export function openBundleFile(dir: string, name: string, ring: KeyRing, expect?: ArtefactInfo): Readable {
  const hash = createHash("sha256")
  let bytes = 0
  const check = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      bytes += chunk.length
      cb(null, chunk)
    },
    flush(cb) {
      if (expect && (hash.digest("hex") !== expect.plaintextSha256 || bytes !== expect.plaintextBytes)) {
        cb(new Error(`${name}: plaintext SHA-256 differs from the manifest`))
        return
      }
      cb()
    },
  })
  // The callback form returns the last stream; a failure anywhere upstream destroys it with that error.
  return pipelineWithCallback(createReadStream(path.join(dir, `${name}.skb`)), createDecryptStream(ring), check, () => undefined) as unknown as Readable
}
