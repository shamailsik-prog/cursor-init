import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { describe, expect, it } from "vitest"
import {
  EnvelopeError,
  HEADER_BYTES,
  createDecryptStream,
  createEncryptStream,
  decryptBuffer,
  encryptBuffer,
  keyIdOf,
  makeKeyRing,
  parseMasterKey,
} from "../lib/envelope.mjs"

function newKey(): Buffer {
  return randomBytes(32)
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof EnvelopeError) return err.code
    throw err
  }
  return "NO_ERROR"
}

async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of readable) parts.push(Buffer.from(part as Buffer))
  return Buffer.concat(parts)
}

function flipped(buf: Buffer, index: number): Buffer {
  const copy = Buffer.from(buf)
  copy[index] ^= 0x01
  return copy
}

const EXP = 10 // 1 KiB chunks: multi-chunk cases stay tiny
const CHUNK = 1 << EXP
const ENC_CHUNK = CHUNK + 16

describe("SKB1 envelope: round trips", () => {
  it("round-trips at the default 64 KiB chunk size around every boundary", () => {
    const key = newKey()
    const ring = makeKeyRing(key)
    for (const length of [0, 1, 65_535, 65_536, 65_537, 3 * 65_536 + 5]) {
      const plain = randomBytes(length)
      const sealed = encryptBuffer(key, plain)
      expect(decryptBuffer(ring, sealed).equals(plain), `length ${length}`).toBe(true)
    }
  })

  it("round-trips with 1 KiB chunks, including every exact multiple", () => {
    const key = newKey()
    const ring = makeKeyRing(key)
    for (const length of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK, 3 * CHUNK + 7]) {
      const plain = randomBytes(length)
      const sealed = encryptBuffer(key, plain, { chunkExp: EXP })
      expect(sealed.length).toBe(HEADER_BYTES + length + 16 * Math.max(1, Math.ceil(length / CHUNK)))
      expect(decryptBuffer(ring, sealed).equals(plain), `length ${length}`).toBe(true)
    }
  })

  it("writes a 48-byte header: magic, version 1, chunk exponent, two zero bytes, the key id, a 32-byte salt", () => {
    const key = newKey()
    const sealed = encryptBuffer(key, Buffer.from("x"), { chunkExp: EXP })
    expect(HEADER_BYTES).toBe(48)
    expect(sealed.subarray(0, 4).toString("latin1")).toBe("SKB1")
    expect(sealed[4]).toBe(1)
    expect(sealed[5]).toBe(EXP)
    expect(sealed[6]).toBe(0)
    expect(sealed[7]).toBe(0)
    expect(sealed.subarray(8, 16).toString("hex")).toBe(keyIdOf(key))
    expect(keyIdOf(key)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("streams in odd write sizes to the same plaintext", async () => {
    const key = newKey()
    const ring = makeKeyRing(key)
    const plain = randomBytes(5 * CHUNK + 123)
    const slices: Buffer[] = []
    for (let at = 0; at < plain.length; at += 7 * 13) slices.push(plain.subarray(at, at + 7 * 13))
    const sealed = await collect(Readable.from(slices).pipe(createEncryptStream(key, { chunkExp: EXP })))
    const oddSealed: Buffer[] = []
    for (let at = 0; at < sealed.length; at += 997) oddSealed.push(sealed.subarray(at, at + 997))
    const opened = await collect(Readable.from(oddSealed).pipe(createDecryptStream(ring)))
    expect(opened.equals(plain)).toBe(true)
  })

  it("uses a fresh salt per file: the same plaintext seals differently, and both open", () => {
    const key = newKey()
    const ring = makeKeyRing(key)
    const plain = randomBytes(300)
    const a = encryptBuffer(key, plain)
    const b = encryptBuffer(key, plain)
    expect(a.equals(b)).toBe(false)
    expect(a.subarray(16, 48).equals(b.subarray(16, 48))).toBe(false)
    expect(decryptBuffer(ring, a).equals(plain)).toBe(true)
    expect(decryptBuffer(ring, b).equals(plain)).toBe(true)
  })

  it("leaves no plaintext in the ciphertext", () => {
    const key = newKey()
    const marker = Buffer.from("PLAINTEXT-MARKER-F33-0123456789")
    const sealed = encryptBuffer(key, Buffer.concat([marker, randomBytes(2000)]), { chunkExp: EXP })
    expect(sealed.includes(marker)).toBe(false)
    expect(sealed.includes(marker.subarray(0, 12))).toBe(false)
  })

  it("opens a file sealed with a previous key when the ring holds it, and names the key it needs when not", () => {
    const oldKey = newKey()
    const newer = newKey()
    const sealed = encryptBuffer(oldKey, Buffer.from("old backup"))
    expect(decryptBuffer(makeKeyRing(newer, [oldKey]), sealed).toString()).toBe("old backup")
    expect(codeOf(() => decryptBuffer(makeKeyRing(newer), sealed))).toBe("UNKNOWN_KEY")
    expect(() => decryptBuffer(makeKeyRing(newer), sealed)).toThrow(keyIdOf(oldKey))
  })
})

describe("SKB1 envelope: refusals", () => {
  const key = newKey()
  const ring = makeKeyRing(key)
  const plain = randomBytes(3 * CHUNK) // exactly three chunks: the final chunk is full-size
  const sealed = encryptBuffer(key, plain, { chunkExp: EXP })
  const short = encryptBuffer(key, randomBytes(2 * CHUNK + 40), { chunkExp: EXP }) // short final chunk

  it("refuses a wrong magic", () => {
    expect(codeOf(() => decryptBuffer(ring, flipped(sealed, 0)))).toBe("BAD_MAGIC")
  })

  it.each([4, 6, 7])("refuses a changed version or reserved byte (header byte %i)", (index) => {
    expect(codeOf(() => decryptBuffer(ring, flipped(sealed, index)))).toBe("BAD_HEADER")
  })

  it("refuses a chunk exponent outside 10 to 24, and an in-range one that no longer matches the chunks", () => {
    for (const exp of [0, 9, 25, 255]) {
      const bad = Buffer.from(sealed)
      bad[5] = exp
      expect(codeOf(() => decryptBuffer(ring, bad)), `exponent ${exp}`).toBe("BAD_HEADER")
    }
    expect(codeOf(() => decryptBuffer(ring, flipped(sealed, 5)))).toBe("AUTH_FAILED")
  })

  it.each([8, 11, 15])("refuses a key id that is not in the ring (header byte %i)", (index) => {
    expect(codeOf(() => decryptBuffer(ring, flipped(sealed, index)))).toBe("UNKNOWN_KEY")
  })

  it("refuses a file sealed with another key", () => {
    const other = encryptBuffer(newKey(), plain, { chunkExp: EXP })
    expect(codeOf(() => decryptBuffer(ring, other))).toBe("UNKNOWN_KEY")
  })

  it.each([16, 30, 47])("refuses a changed salt (header byte %i): the header is the associated data", (index) => {
    expect(codeOf(() => decryptBuffer(ring, flipped(sealed, index)))).toBe("AUTH_FAILED")
  })

  it("refuses one flipped byte anywhere in a chunk or its tag", () => {
    const start = HEADER_BYTES
    const lastChunk = start + 2 * ENC_CHUNK
    for (const index of [start, start + 17, start + ENC_CHUNK - 1, start + ENC_CHUNK, start + ENC_CHUNK + 500, lastChunk, lastChunk + 3, sealed.length - 1]) {
      expect(codeOf(() => decryptBuffer(ring, flipped(sealed, index))), `byte ${index}`).toBe("AUTH_FAILED")
    }
  })

  it("refuses swapped chunks", () => {
    const start = HEADER_BYTES
    const swapped = Buffer.concat([
      sealed.subarray(0, start),
      sealed.subarray(start + ENC_CHUNK, start + 2 * ENC_CHUNK),
      sealed.subarray(start, start + ENC_CHUNK),
      sealed.subarray(start + 2 * ENC_CHUNK),
    ])
    expect(codeOf(() => decryptBuffer(ring, swapped))).toBe("AUTH_FAILED")
  })

  it("refuses a stream that ends without its final chunk (cut at a chunk boundary)", () => {
    const cut = sealed.subarray(0, HEADER_BYTES + 2 * ENC_CHUNK)
    expect(codeOf(() => decryptBuffer(ring, cut))).toBe("TRUNCATED")
  })

  it("refuses a stream cut inside a chunk, and a header cut short, and nothing at all", () => {
    expect(codeOf(() => decryptBuffer(ring, sealed.subarray(0, sealed.length - 1)))).toBe("AUTH_FAILED")
    expect(codeOf(() => decryptBuffer(ring, sealed.subarray(0, HEADER_BYTES + 5)))).toBe("TRUNCATED")
    expect(codeOf(() => decryptBuffer(ring, sealed.subarray(0, 20)))).toBe("TRUNCATED")
    expect(codeOf(() => decryptBuffer(ring, Buffer.alloc(0)))).toBe("TRUNCATED")
  })

  it("refuses bytes after a full-size final chunk", () => {
    expect(codeOf(() => decryptBuffer(ring, Buffer.concat([sealed, Buffer.from([0])])))).toBe("TRAILING_DATA")
    expect(codeOf(() => decryptBuffer(ring, Buffer.concat([sealed, randomBytes(ENC_CHUNK)])))).toBe("TRAILING_DATA")
  })

  it("refuses an extension after a short final chunk (indistinguishable from corruption: AUTH_FAILED)", () => {
    expect(codeOf(() => decryptBuffer(ring, Buffer.concat([short, Buffer.from([0])])))).toBe("AUTH_FAILED")
  })

  it("surfaces the same refusal from the stream, with the error code intact", async () => {
    const bad = flipped(sealed, HEADER_BYTES + 100)
    const attempt = pipeline(Readable.from([bad]), createDecryptStream(ring), async (source) => {
      for await (const chunk of source) void chunk
    })
    await expect(attempt).rejects.toMatchObject({ name: "EnvelopeError", code: "AUTH_FAILED" })
  })

  it("never emits plaintext of a chunk that fails to authenticate", async () => {
    const bad = flipped(sealed, HEADER_BYTES + ENC_CHUNK + 5) // second chunk bad: the first may be emitted, the second never
    const seen: Buffer[] = []
    const attempt = pipeline(Readable.from([bad]), createDecryptStream(ring), async (source) => {
      for await (const chunk of source) seen.push(Buffer.from(chunk as Buffer))
    })
    await expect(attempt).rejects.toMatchObject({ code: "AUTH_FAILED" })
    const emitted = Buffer.concat(seen)
    expect(emitted.length).toBeLessThanOrEqual(CHUNK)
    expect(plain.subarray(0, emitted.length).equals(emitted)).toBe(true)
  })
})

describe("master key parsing", () => {
  it("accepts 64 hex characters, either case, and trims", () => {
    const raw = randomBytes(32)
    expect(parseMasterKey(`  ${raw.toString("hex")}\n`).equals(raw)).toBe(true)
    expect(parseMasterKey(raw.toString("hex").toUpperCase()).equals(raw)).toBe(true)
  })

  it.each([
    ["too short", () => randomBytes(31).toString("hex")],
    ["too long", () => randomBytes(33).toString("hex")],
    ["not hex", () => "z".repeat(64)],
    ["empty", () => ""],
    ["all zero", () => "00".repeat(32)],
    ["all ff", () => "ff".repeat(32)],
    ["one byte repeated", () => "5a".repeat(32)],
  ])("refuses a key that is %s", (_name, make) => {
    expect(codeOf(() => parseMasterKey(make()))).toBe("BAD_KEY")
  })

  it("never echoes the key in the error message", () => {
    const secret = "5a".repeat(32)
    try {
      parseMasterKey(secret)
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
    }
  })

  it("refuses to encrypt with a key that is not 32 bytes", () => {
    expect(codeOf(() => encryptBuffer(Buffer.alloc(16, 1), Buffer.from("x")))).toBe("BAD_KEY")
  })
})
