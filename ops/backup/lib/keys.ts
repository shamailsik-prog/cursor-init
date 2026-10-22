import { readFileSync, statSync } from "node:fs"
import { EnvelopeError, makeKeyRing, parseMasterKey, type KeyRing } from "./envelope.mjs"

export const BACKUP_KEY_ENV = "SIKANDER_BACKUP_KEY"
export const BACKUP_PREVIOUS_KEYS_ENV = "SIKANDER_BACKUP_PREVIOUS_KEYS"

export type KeyRingOptions = {
  env?: NodeJS.ProcessEnv
  /** A file holding the 64 hex characters (spec R4). Mutually exclusive with SIKANDER_BACKUP_KEY. */
  keyFile?: string
  fs?: { readFileSync: (path: string, encoding: "utf8") => string; statSync: (path: string) => { mode: number } }
}

function fail(message: string): never {
  throw new EnvelopeError("BAD_KEY", message)
}

/**
 * The key ring of a backup or restore: the current key (to encrypt with and to decrypt with) and any previous
 * keys (decrypt only). The key is configuration, never a literal in the tree (spec R4); no message here ever
 * contains key material.
 */
export function loadKeyRing(options: KeyRingOptions = {}): KeyRing {
  const env = options.env ?? process.env
  const fs = options.fs ?? { readFileSync: (p: string, e: "utf8") => readFileSync(p, e), statSync }
  const inline = env[BACKUP_KEY_ENV]?.trim()
  const file = options.keyFile?.trim()
  if (inline && file) fail(`give the backup key either in ${BACKUP_KEY_ENV} or in a key file, not both`)
  let current: string
  if (file) {
    if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
      fail("the backup key file must not be readable by group or others (mode 0600)")
    }
    current = fs.readFileSync(file, "utf8")
  } else if (inline) {
    current = inline
  } else {
    fail(`no backup key: set ${BACKUP_KEY_ENV} or pass a key file`)
  }
  const previous: Buffer[] = []
  for (const part of (env[BACKUP_PREVIOUS_KEYS_ENV] ?? "").split(",")) {
    const text = part.trim()
    if (!text) continue
    try {
      previous.push(parseMasterKey(text))
    } catch {
      fail(`a previous key in ${BACKUP_PREVIOUS_KEYS_ENV} is not 64 hex characters, or is one byte repeated`)
    }
  }
  return makeKeyRing(parseMasterKey(current), previous)
}
