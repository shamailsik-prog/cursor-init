/**
 * The corpus reader's configuration (audit F05, plan D8), read from the environment only:
 *
 * - SIKANDER_CORPUS_READER_URL: `postgres://` or `postgresql://`, with a user, a password, a host and one database.
 *   The only query parameter it may carry is `sslmode`, and only `verify-full` counts as TLS. `disable`, or no
 *   sslmode, is plaintext. Any other mode is refused rather than half-honoured, and any other parameter is refused
 *   too: none of it reaches `pg`, which gets the fields one by one.
 * - SIKANDER_CORPUS_MAX_STALENESS_HOURS: required (spec ruling 5), an integer from 1 to 8760.
 * - SIKANDER_CORPUS_READER_CA: the PEM certificate the server's chain must reach, required whenever TLS is.
 *
 * In production the URL must ask for verify-full. Outside production, plaintext is allowed to loopback only
 * (127.0.0.1, ::1, localhost); any other host needs the same TLS. A refusal carries a reason token and nothing else:
 * never the URL, the password or the CA.
 */
import { createHash } from "node:crypto"

export type CorpusReaderConfig = {
  host: string
  port: number
  database: string
  user: string
  password: string
  /** The PEM CA for TLS (verify-full), or null for loopback plaintext outside production. */
  ca: string | null
  maxStalenessHours: number
  /** sha256 hex of the other fields: the memo key for the store. Never logged. */
  key: string
}

export type CorpusReaderConfigRefusal = "missing" | "invalid_url" | "invalid_staleness" | "tls_required" | "invalid_ca"

export type CorpusReaderConfigResult = { ok: true; config: CorpusReaderConfig } | { ok: false; reason: CorpusReaderConfigRefusal }

export const MAX_STALENESS_HOURS_LIMIT = 8760
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"])
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/

const refuse = (reason: CorpusReaderConfigRefusal): CorpusReaderConfigResult => ({ ok: false, reason })

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

type ParsedUrl = { host: string; port: number; database: string; user: string; password: string; tls: boolean | "weak" }

function parseUrl(raw: string): ParsedUrl | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null
  const user = decode(url.username)
  const password = decode(url.password)
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  const segments = url.pathname.replace(/^\//, "").split("/")
  const database = segments.length === 1 ? decode(segments[0]) : null
  if (!user || !password || !host || !database) return null
  const port = url.port === "" ? 5432 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const params = [...url.searchParams.keys()]
  if (params.some((k) => k !== "sslmode") || url.searchParams.getAll("sslmode").length > 1 || url.hash !== "") return null
  const mode = url.searchParams.get("sslmode")
  const tls = mode === "verify-full" ? true : mode === null || mode === "disable" ? false : "weak"
  return { host, port, database, user, password, tls }
}

export function readCorpusReaderConfig(
  env: Record<string, string | undefined>,
  production: boolean = process.env.NODE_ENV === "production"
): CorpusReaderConfigResult {
  const raw = (env.SIKANDER_CORPUS_READER_URL ?? "").trim()
  if (!raw) return refuse("missing")
  const parsed = parseUrl(raw)
  if (!parsed) return refuse("invalid_url")
  const hours = env.SIKANDER_CORPUS_MAX_STALENESS_HOURS ?? ""
  if (!/^[1-9][0-9]{0,3}$/.test(hours) || Number(hours) > MAX_STALENESS_HOURS_LIMIT) return refuse("invalid_staleness")
  const maxStalenessHours = Number(hours)

  let ca: string | null = null
  if (parsed.tls === true) {
    const pem = env.SIKANDER_CORPUS_READER_CA ?? ""
    if (!pem.trim()) return refuse("tls_required")
    if (!PEM_CERTIFICATE.test(pem)) return refuse("invalid_ca")
    ca = pem
  } else if (parsed.tls === "weak" || production || !LOOPBACK_HOSTS.has(parsed.host.toLowerCase())) {
    return refuse("tls_required")
  }

  const fields = { host: parsed.host, port: parsed.port, database: parsed.database, user: parsed.user, password: parsed.password, ca, maxStalenessHours }
  const key = createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex")
  return { ok: true, config: { ...fields, key } }
}
