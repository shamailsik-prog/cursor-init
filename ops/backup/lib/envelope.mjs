// SKB1: the encryption envelope of every F33 backup artefact (spec R3). Dependency-free on purpose: the
// WAL archive_command (bin/pg-wal.mjs) runs it under plain `node`, once per segment, with no loader.
//
// Format (all integers big-endian):
//   header, 48 bytes: "SKB1" | version 1 | chunk-size exponent | 2 reserved zero bytes | 8-byte key id | 32-byte salt
//   then chunks of (1 << exponent) plaintext bytes, each sealed as ciphertext || 16-byte GCM tag; the last chunk
//   (possibly empty, never absent) is sealed as the final one.
//   file key  = HKDF-SHA256(master key, salt, "sikander-backup/file-key/v1", 32)
//   nonce(i)  = u64(i) || u32(final ? 1 : 0)       AAD = the 48 header bytes
//   key id    = first 8 bytes of HMAC-SHA256(master key, "sikander-backup/key-id/v1")
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import { Transform } from "node:stream"

export const HEADER_BYTES = 48
export const DEFAULT_CHUNK_EXP = 16
const MIN_CHUNK_EXP = 10
const MAX_CHUNK_EXP = 24
const TAG_BYTES = 16
const MAGIC = Buffer.from("SKB1", "latin1")
const VERSION = 1
const FILE_KEY_INFO = Buffer.from("sikander-backup/file-key/v1")
const KEY_ID_INFO = "sikander-backup/key-id/v1"

export class EnvelopeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = "EnvelopeError"
    this.code = code
  }
}

/** @param {string} hex */
export function parseMasterKey(hex) {
  const text = typeof hex === "string" ? hex.trim() : ""
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new EnvelopeError("BAD_KEY", "the backup key must be 64 hex characters (32 bytes)")
  }
  const key = Buffer.from(text, "hex")
  if (key.every((byte) => byte === key[0])) {
    throw new EnvelopeError("BAD_KEY", "the backup key must not be one byte repeated (all-zero, all-ff and the like)")
  }
  return key
}

/** @param {Buffer} key */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new EnvelopeError("BAD_KEY", "the backup key must be 32 bytes")
  }
}

/** The 16-hex-character name of a key; it does not reveal the key. @param {Buffer} key */
export function keyIdOf(key) {
  assertKey(key)
  return createHmac("sha256", key).update(KEY_ID_INFO).digest().subarray(0, 8).toString("hex")
}

/** @param {Buffer} current @param {Buffer[]} [previous] */
export function makeKeyRing(current, previous = []) {
  assertKey(current)
  const byId = new Map()
  for (const key of [current, ...previous]) {
    assertKey(key)
    byId.set(keyIdOf(key), key)
  }
  return { current, byId }
}

/** @param {Buffer} masterKey @param {Buffer} salt */
function fileKey(masterKey, salt) {
  return Buffer.from(hkdfSync("sha256", masterKey, salt, FILE_KEY_INFO, 32))
}

/** @param {number} index @param {boolean} final */
function nonceOf(index, final) {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(BigInt(index), 0)
  nonce.writeUInt32BE(final ? 1 : 0, 8)
  return nonce
}

/** @param {Buffer} key @param {Buffer} header @param {number} index @param {Buffer} plain @param {boolean} final */
function sealChunk(key, header, index, plain, final) {
  const cipher = createCipheriv("aes-256-gcm", key, nonceOf(index, final), { authTagLength: TAG_BYTES })
  cipher.setAAD(header)
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

/** Returns the plaintext, or null when the chunk does not authenticate. */
function openChunk(key, header, index, sealed, final) {
  if (sealed.length < TAG_BYTES) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonceOf(index, final), { authTagLength: TAG_BYTES })
    decipher.setAAD(header)
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()])
  } catch {
    return null
  }
}

/** @param {number} chunkExp */
function assertChunkExp(chunkExp) {
  if (!Number.isInteger(chunkExp) || chunkExp < MIN_CHUNK_EXP || chunkExp > MAX_CHUNK_EXP) {
    throw new EnvelopeError("BAD_HEADER", `chunk exponent must be an integer from ${MIN_CHUNK_EXP} to ${MAX_CHUNK_EXP}`)
  }
}

class EncryptCore {
  /** @param {Buffer} masterKey @param {number} chunkExp */
  constructor(masterKey, chunkExp) {
    assertKey(masterKey)
    assertChunkExp(chunkExp)
    this.chunkSize = 2 ** chunkExp
    const salt = randomBytes(32)
    this.header = Buffer.concat([
      MAGIC,
      Buffer.from([VERSION, chunkExp, 0, 0]),
      Buffer.from(keyIdOf(masterKey), "hex"),
      salt,
    ])
    this.key = fileKey(masterKey, salt)
    this.index = 0
    this.pending = Buffer.alloc(0)
    this.started = false
  }

  /** @returns {Buffer[]} */
  #begin() {
    if (this.started) return []
    this.started = true
    return [this.header]
  }

  /** @param {Buffer} data @returns {Buffer[]} */
  update(data) {
    const out = this.#begin()
    this.pending = this.pending.length === 0 ? data : Buffer.concat([this.pending, data])
    // The last chunk must be sealed as final, so a full chunk is held back until more data arrives.
    while (this.pending.length > this.chunkSize) {
      out.push(sealChunk(this.key, this.header, this.index++, this.pending.subarray(0, this.chunkSize), false))
      this.pending = this.pending.subarray(this.chunkSize)
    }
    return out
  }

  /** @returns {Buffer[]} */
  final() {
    const out = this.#begin()
    out.push(sealChunk(this.key, this.header, this.index++, this.pending, true))
    this.pending = Buffer.alloc(0)
    return out
  }
}

class DecryptCore {
  /** @param {{ byId: Map<string, Buffer> }} ring */
  constructor(ring) {
    this.ring = ring
    this.header = null
    this.key = null
    this.chunkSize = 0
    this.index = 0
    this.pending = Buffer.alloc(0)
  }

  #readHeader() {
    if (this.header || this.pending.length < HEADER_BYTES) return
    const header = this.pending.subarray(0, HEADER_BYTES)
    if (!header.subarray(0, 4).equals(MAGIC)) throw new EnvelopeError("BAD_MAGIC", "not an SKB1 file (bad magic)")
    if (header[4] !== VERSION || header[6] !== 0 || header[7] !== 0) {
      throw new EnvelopeError("BAD_HEADER", `unsupported SKB1 header (version ${header[4]})`)
    }
    assertChunkExp(header[5])
    const id = header.subarray(8, 16).toString("hex")
    const master = this.ring.byId.get(id)
    if (!master) {
      throw new EnvelopeError("UNKNOWN_KEY", `this file was sealed with key ${id}, which is not in the key ring`)
    }
    this.header = Buffer.from(header)
    this.chunkSize = 2 ** header[5]
    this.key = fileKey(master, header.subarray(16, 48))
    this.pending = this.pending.subarray(HEADER_BYTES)
  }

  /** @param {Buffer} data @returns {Buffer[]} */
  update(data) {
    this.pending = this.pending.length === 0 ? data : Buffer.concat([this.pending, data])
    this.#readHeader()
    const out = []
    if (!this.header) return out
    const sealedSize = this.chunkSize + TAG_BYTES
    // More than one chunk's worth is pending, so the leading chunk cannot be the last one.
    while (this.pending.length > sealedSize) {
      const sealed = this.pending.subarray(0, sealedSize)
      const plain = openChunk(this.key, this.header, this.index, sealed, false)
      if (!plain) {
        if (openChunk(this.key, this.header, this.index, sealed, true)) {
          throw new EnvelopeError("TRAILING_DATA", "bytes follow the final chunk")
        }
        throw new EnvelopeError("AUTH_FAILED", `chunk ${this.index} failed authentication`)
      }
      out.push(plain)
      this.index++
      this.pending = this.pending.subarray(sealedSize)
    }
    return out
  }

  /** @returns {Buffer[]} */
  final() {
    if (!this.header) throw new EnvelopeError("TRUNCATED", "the file ends before its header is complete")
    if (this.pending.length < TAG_BYTES) throw new EnvelopeError("TRUNCATED", "the file ends without a final chunk")
    const plain = openChunk(this.key, this.header, this.index, this.pending, true)
    if (plain) {
      this.pending = Buffer.alloc(0)
      return [plain]
    }
    if (openChunk(this.key, this.header, this.index, this.pending, false)) {
      throw new EnvelopeError("TRUNCATED", "the file ends without a final chunk")
    }
    throw new EnvelopeError("AUTH_FAILED", `chunk ${this.index} failed authentication`)
  }
}

/** @param {Buffer} key @param {{ chunkExp?: number }} [opts] */
export function createEncryptStream(key, opts = {}) {
  const core = new EncryptCore(key, opts.chunkExp ?? DEFAULT_CHUNK_EXP)
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        for (const part of core.update(Buffer.from(chunk))) this.push(part)
        callback()
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        for (const part of core.final()) this.push(part)
        callback()
      } catch (err) {
        callback(err)
      }
    },
  })
}

/** @param {{ byId: Map<string, Buffer> }} ring */
export function createDecryptStream(ring) {
  const core = new DecryptCore(ring)
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        for (const part of core.update(Buffer.from(chunk))) this.push(part)
        callback()
      } catch (err) {
        callback(err)
      }
    },
    flush(callback) {
      try {
        for (const part of core.final()) this.push(part)
        callback()
      } catch (err) {
        callback(err)
      }
    },
  })
}

/** @param {Buffer} key @param {Buffer} data @param {{ chunkExp?: number }} [opts] */
export function encryptBuffer(key, data, opts = {}) {
  const core = new EncryptCore(key, opts.chunkExp ?? DEFAULT_CHUNK_EXP)
  return Buffer.concat([...core.update(data), ...core.final()])
}

/** @param {{ byId: Map<string, Buffer> }} ring @param {Buffer} data */
export function decryptBuffer(ring, data) {
  const core = new DecryptCore(ring)
  return Buffer.concat([...core.update(data), ...core.final()])
}
