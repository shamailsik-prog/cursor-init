import { describe, expect, it } from "vitest"
import { readCorpusReaderConfig, type CorpusReaderConfigResult } from "../src/d4/corpusReaderConfig"

/**
 * F05 plan D8: the corpus reader's configuration, read from the environment only. No database is needed here. The
 * password is a fixture value generated for this file; nothing here is a real credential or host.
 */
const PASSWORD = `pw-${Math.random().toString(36).slice(2)}`
const LOOPBACK = `postgres://reader:${PASSWORD}@127.0.0.1:55432/corpus`
const REMOTE = `postgresql://reader:${PASSWORD}@10.0.0.5:5432/corpus`
const CA = "-----BEGIN CERTIFICATE-----\nMIIBfixturefixturefixture\n-----END CERTIFICATE-----\n"

const env = (url: string | undefined, extra: Record<string, string | undefined> = {}) => ({
  SIKANDER_CORPUS_READER_URL: url,
  SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24",
  ...extra,
})
const reason = (r: CorpusReaderConfigResult) => (r.ok ? "ok" : r.reason)

describe("readCorpusReaderConfig (F05 plan D8)", () => {
  it("an unset or blank URL is missing", () => {
    expect(reason(readCorpusReaderConfig({}, false))).toBe("missing")
    expect(reason(readCorpusReaderConfig(env(undefined), false))).toBe("missing")
    expect(reason(readCorpusReaderConfig(env("   "), false))).toBe("missing")
  })

  it("the staleness bound is required: an integer from 1 to 8760 hours, nothing else (ruling 5)", () => {
    for (const hours of [undefined, "", "0", "-1", "1.5", "8761", "abc", " 24", "24h", "1e2", "0x10"]) {
      expect(reason(readCorpusReaderConfig(env(LOOPBACK, { SIKANDER_CORPUS_MAX_STALENESS_HOURS: hours }), false)), String(hours)).toBe(
        "invalid_staleness"
      )
    }
    for (const [hours, n] of [["1", 1], ["24", 24], ["8760", 8760]] as const) {
      const r = readCorpusReaderConfig(env(LOOPBACK, { SIKANDER_CORPUS_MAX_STALENESS_HOURS: hours }), false)
      expect(r.ok && r.config.maxStalenessHours).toBe(n)
    }
  })

  it("the URL must be postgres:// or postgresql:// with a user, a password, a host and one database, and no other parameter", () => {
    for (const url of [
      "not a url",
      `http://reader:${PASSWORD}@127.0.0.1:5432/corpus`,
      "postgres://reader@127.0.0.1:5432/corpus",
      `postgres://:${PASSWORD}@127.0.0.1:5432/corpus`,
      `postgres://reader:${PASSWORD}@127.0.0.1:5432/`,
      `postgres://reader:${PASSWORD}@127.0.0.1:5432`,
      `postgres://reader:${PASSWORD}@127.0.0.1:5432/corpus/extra`,
      `postgres://reader:${PASSWORD}@127.0.0.1:0/corpus`,
      `postgres://reader:${PASSWORD}@127.0.0.1:5432/corpus?sslrootcert=/tmp/ca.pem`,
      `postgres://reader:${PASSWORD}@127.0.0.1:5432/corpus?options=-c%20role%3Dpostgres`,
      `postgres://reader:%E0%A4%A@127.0.0.1:5432/corpus`,
    ]) {
      expect(reason(readCorpusReaderConfig(env(url), false)), url.replace(PASSWORD, "<pw>")).toBe("invalid_url")
    }
  })

  it("outside production, plaintext is allowed to loopback only; the fields are decoded and the port defaults to 5432", () => {
    const loop = readCorpusReaderConfig(env(LOOPBACK), false)
    expect(loop).toEqual({
      ok: true,
      config: { host: "127.0.0.1", port: 55432, database: "corpus", user: "reader", password: PASSWORD, ca: null, maxStalenessHours: 24, key: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    for (const [url, host] of [
      [`postgres://reader:${PASSWORD}@localhost/corpus`, "localhost"],
      [`postgres://reader:${PASSWORD}@[::1]:5433/corpus`, "::1"],
      [`postgresql://reader:${PASSWORD}@127.0.0.1/corpus?sslmode=disable`, "127.0.0.1"],
    ] as const) {
      const r = readCorpusReaderConfig(env(url), false)
      expect(r.ok && { host: r.config.host, ca: r.config.ca }, url.replace(PASSWORD, "<pw>")).toEqual({ host, ca: null })
    }
    const decoded = readCorpusReaderConfig(env("postgres://re%40der:p%40ss%2Fw0rd@127.0.0.1/cor%20pus"), false)
    expect(decoded.ok && [decoded.config.user, decoded.config.password, decoded.config.database, decoded.config.port]).toEqual([
      "re@der",
      "p@ss/w0rd",
      "cor pus",
      5432,
    ])
    expect(reason(readCorpusReaderConfig(env(REMOTE), false))).toBe("tls_required")
    // Only verify-full counts as TLS: a weaker mode is refused rather than half-honoured.
    expect(reason(readCorpusReaderConfig(env(`${LOOPBACK}?sslmode=require`), false))).toBe("tls_required")
    expect(reason(readCorpusReaderConfig(env(`${REMOTE}?sslmode=verify-ca`, { SIKANDER_CORPUS_READER_CA: CA }), false))).toBe("tls_required")
    const remote = readCorpusReaderConfig(env(`${REMOTE}?sslmode=verify-full`, { SIKANDER_CORPUS_READER_CA: CA }), false)
    expect(remote.ok && { host: remote.config.host, ca: remote.config.ca }).toEqual({ host: "10.0.0.5", ca: CA })
  })

  it("in production the URL must ask for sslmode=verify-full and the CA must be a PEM certificate", () => {
    expect(reason(readCorpusReaderConfig(env(LOOPBACK), true))).toBe("tls_required")
    expect(reason(readCorpusReaderConfig(env(`${LOOPBACK}?sslmode=disable`), true))).toBe("tls_required")
    expect(reason(readCorpusReaderConfig(env(`${REMOTE}?sslmode=verify-full`), true))).toBe("tls_required")
    expect(reason(readCorpusReaderConfig(env(`${REMOTE}?sslmode=verify-full`, { SIKANDER_CORPUS_READER_CA: "not a certificate" }), true))).toBe(
      "invalid_ca"
    )
    const ok = readCorpusReaderConfig(env(`${REMOTE}?sslmode=verify-full`, { SIKANDER_CORPUS_READER_CA: CA }), true)
    expect(ok.ok && { ca: ok.config.ca, host: ok.config.host }).toEqual({ ca: CA, host: "10.0.0.5" })
  })

  it("by default production is NODE_ENV=production", () => {
    const saved = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = "production"
      expect(reason(readCorpusReaderConfig(env(LOOPBACK)))).toBe("tls_required")
      process.env.NODE_ENV = "test"
      expect(reason(readCorpusReaderConfig(env(LOOPBACK)))).toBe("ok")
    } finally {
      process.env.NODE_ENV = saved
    }
  })

  it("equal configs share a key; a different password, host, database or staleness gives another", () => {
    const keyOf = (e: Record<string, string | undefined>) => {
      const r = readCorpusReaderConfig(e, false)
      if (!r.ok) throw new Error(r.reason)
      return r.config.key
    }
    const base = keyOf(env(LOOPBACK))
    expect(keyOf(env(LOOPBACK))).toBe(base)
    expect(keyOf(env(LOOPBACK.replace(PASSWORD, `${PASSWORD}x`)))).not.toBe(base)
    expect(keyOf(env(LOOPBACK.replace("127.0.0.1", "localhost")))).not.toBe(base)
    expect(keyOf(env(LOOPBACK.replace("/corpus", "/corpus2")))).not.toBe(base)
    expect(keyOf(env(LOOPBACK, { SIKANDER_CORPUS_MAX_STALENESS_HOURS: "25" }))).not.toBe(base)
  })

  it("only the current password is held: rotating away and back gives a fresh key, so the store is rebuilt", () => {
    const keyOf = (e: Record<string, string | undefined>) => {
      const r = readCorpusReaderConfig(e, false)
      if (!r.ok) throw new Error(r.reason)
      return r.config.key
    }
    const first = keyOf(env(LOOPBACK))
    const rotated = keyOf(env(LOOPBACK.replace(PASSWORD, `${PASSWORD}r`)))
    const back = keyOf(env(LOOPBACK))
    expect(rotated).not.toBe(first)
    expect(back).not.toBe(first)
    expect(back).not.toBe(rotated)
    expect(keyOf(env(LOOPBACK))).toBe(back)
  })

  it("a refusal carries the reason only: never the URL, the password or the CA", () => {
    for (const [e, production] of [
      [env(REMOTE), false],
      [env(`${REMOTE}?sslmode=verify-full`, { SIKANDER_CORPUS_READER_CA: "bad" }), true],
      [env(LOOPBACK, { SIKANDER_CORPUS_MAX_STALENESS_HOURS: "0" }), false],
      [env(`postgres://reader:${PASSWORD}@127.0.0.1:5432/`), false],
    ] as const) {
      const r = readCorpusReaderConfig(e, production)
      expect(r.ok).toBe(false)
      expect(Object.keys(r).sort()).toEqual(["ok", "reason"])
      expect(JSON.stringify(r)).not.toContain(PASSWORD)
    }
  })
})
