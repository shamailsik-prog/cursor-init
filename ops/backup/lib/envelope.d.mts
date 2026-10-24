import type { Transform } from "node:stream"

export const HEADER_BYTES: 48
export const DEFAULT_CHUNK_EXP: 16

export type EnvelopeErrorCode =
  | "BAD_MAGIC"
  | "BAD_HEADER"
  | "UNKNOWN_KEY"
  | "AUTH_FAILED"
  | "TRUNCATED"
  | "TRAILING_DATA"
  | "BAD_KEY"

export class EnvelopeError extends Error {
  constructor(code: EnvelopeErrorCode, message: string)
  readonly name: "EnvelopeError"
  readonly code: EnvelopeErrorCode
}

export type KeyRing = { current: Buffer; byId: Map<string, Buffer> }

/** 64 hex characters, not one byte repeated. */
export function parseMasterKey(hex: string): Buffer
/** The 16-hex-character name of a key; it does not reveal the key. */
export function keyIdOf(key: Buffer): string
export function makeKeyRing(current: Buffer, previous?: Buffer[]): KeyRing
export function createEncryptStream(key: Buffer, opts?: { chunkExp?: number }): Transform
export function createDecryptStream(ring: { byId: Map<string, Buffer> }): Transform
export function encryptBuffer(key: Buffer, data: Buffer, opts?: { chunkExp?: number }): Buffer
export function decryptBuffer(ring: { byId: Map<string, Buffer> }, data: Buffer): Buffer
