import { createHash } from "node:crypto"

/** Order-independent multiset digest over 32-byte row hashes (spec R8). */
export class MultisetDigest {
  private _count = 0
  private s0 = BigInt(0)
  private s1 = BigInt(0)
  private s2 = BigInt(0)
  private s3 = BigInt(0)

  get count(): number {
    return this._count
  }

  add(rowHash: Buffer): void {
    if (rowHash.length !== 32) throw new Error("row hash must be 32 bytes")
    this._count += 1
    this.s0 += rowHash.readBigInt64BE(0)
    this.s1 += rowHash.readBigInt64BE(8)
    this.s2 += rowHash.readBigInt64BE(16)
    this.s3 += rowHash.readBigInt64BE(24)
  }

  digest(): string {
    const body = `${this._count}:${this.s0}:${this.s1}:${this.s2}:${this.s3}`
    return createHash("sha256").update(body, "utf8").digest("hex")
  }
}
