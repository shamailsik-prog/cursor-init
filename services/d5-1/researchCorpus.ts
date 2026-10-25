import type { SpineStore } from "@/platform/spine/store"
import { readCorpusReaderConfig, type CorpusReaderConfig } from "@/functions/src/d4/corpusReaderConfig"
import { CorpusUnavailableError, type CorpusUnavailableReason } from "@/services/d5-1/corpusUnavailable"
import { storeResearchCorpus, type ResearchLoadPlan, type ResearchSource } from "@/services/d5-1/research"

export { CORPUS_UNAVAILABLE_REASONS, CorpusUnavailableError, type CorpusUnavailableReason } from "@/services/d5-1/corpusUnavailable"

/**
 * Which corpus D5 research reads (audit FA-D5-003, spec R13). The production answer is computed by the court-ops core in
 * the Next process (after #106's in-process Functions authority router), so this selection runs there.
 *
 * - `SIKANDER_RESEARCH_CORPUS` unset or `postgres`: the published Annex A corpus, read by `PgResearchCorpus` as a login
 *   that is a member of `corpus_research_reader` only. Its configuration is F05's (`readCorpusReaderConfig`, the same URL
 *   policy: production must use `sslmode=verify-full` with a CA; plaintext only to loopback outside production) under the
 *   research reader's own names: `SIKANDER_CORPUS_RESEARCH_READER_URL` (the DSN secret),
 *   `SIKANDER_CORPUS_RESEARCH_READER_CA`, and the shared `SIKANDER_CORPUS_MAX_STALENESS_HOURS`. No URL: `not_configured`;
 *   anything the parser refuses: `misconfigured`. Either way the load fails closed as `corpus_unavailable`.
 * - `memory`: the in-app read model, only when `NODE_ENV` is `development` or `test` and no hosted-runtime marker is set
 *   (the markers `resolveAuthMode` refuses `insecure-dev` on, platform/p5/session.ts). Elsewhere: `misconfigured`.
 * - Anything else: `misconfigured`.
 * A load that fails logs `d5.research_corpus_unavailable {reason}`, at most once per reason per 30 s, with no driver text,
 * host or credential (spec R10).
 */

export const RESEARCH_SOURCE_ENV = "SIKANDER_RESEARCH_CORPUS"
export const RESEARCH_READER_URL_ENV = "SIKANDER_CORPUS_RESEARCH_READER_URL"
export const RESEARCH_READER_CA_ENV = "SIKANDER_CORPUS_RESEARCH_READER_CA"
export const RESEARCH_STALENESS_ENV = "SIKANDER_CORPUS_MAX_STALENESS_HOURS"
/** The NOLOGIN role 005 creates; the research login must be a member of it and of nothing else (spec R11). */
export const RESEARCH_READER_ROLE = "corpus_research_reader"

/** platform/p5/session.ts HOSTED_RUNTIME_MARKERS: any of these set means a hosted runtime. */
const HOSTED_RUNTIME_MARKERS = ["K_SERVICE", "VERCEL", "VERCEL_ENV", "FUNCTION_TARGET", "FIREBASE_CONFIG", "GAE_SERVICE"] as const

export const UNAVAILABLE_LOG_EVENT = "d5.research_corpus_unavailable"
const LOG_WINDOW_MS = 30_000
const loggedAt = new Map<CorpusUnavailableReason, number>()

/** Whether `reason` should be logged at `now` (once per reason per 30 s); records it when so. */
export function noteCorpusUnavailable(reason: CorpusUnavailableReason, now: number = Date.now()): boolean {
  const last = loggedAt.get(reason)
  if (last !== undefined && now - last < LOG_WINDOW_MS) return false
  loggedAt.set(reason, now)
  return true
}

/** Logs a corpus failure (throttled) and passes every error on unchanged. */
function logged(source: ResearchSource): ResearchSource {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof CorpusUnavailableError && noteCorpusUnavailable(err.reason)) {
        console.warn(UNAVAILABLE_LOG_EVENT, { reason: err.reason })
      }
      throw err
    }
  }
  return {
    load: (plan) => wrap(() => source.load(plan)),
    searchPrepared: source.searchPrepared ? (prepared) => wrap(() => source.searchPrepared!(prepared)) : undefined,
  }
}

/** The in-app read model (tests and local development, when explicitly selected). */
export function memoryResearchSource(store: SpineStore): ResearchSource {
  return {
    async load(plan: ResearchLoadPlan) {
      const { vectors } = plan({
        embeddingModel: store.corpusMetadata.embedding_model,
        embeddingDim: store.corpusMetadata.embedding_dim,
      })
      return storeResearchCorpus(store, vectors)
    },
  }
}

function refusing(reason: CorpusUnavailableReason): ResearchSource {
  return logged({
    async load() {
      throw new CorpusUnavailableError(reason)
    },
  })
}

type PgSource = ResearchSource & { end(): Promise<void> }
/** The Postgres source for the current configuration (one at a time; a new configuration ends the previous pool). */
let pgSource: { key: string; source: Promise<PgSource> } | null = null

function postgresSource(config: CorpusReaderConfig): ResearchSource {
  if (pgSource?.key !== config.key) {
    const previous = pgSource
    // Loaded on first use, so memory mode and unit tests never load the driver.
    pgSource = {
      key: config.key,
      source: import("@/platform/corpus/pgResearchCorpus").then((mod) => new mod.PgResearchCorpus(config)),
    }
    if (previous) void previous.source.then((s) => s.end()).catch(() => undefined)
  }
  const current = pgSource.source
  return logged({
    load: async (plan) => (await current).load(plan),
    searchPrepared: async (prepared) => (await current).searchPrepared(prepared),
  })
}

function hostedRuntime(env: Record<string, string | undefined>): boolean {
  return HOSTED_RUNTIME_MARKERS.some((name) => (env[name] ?? "") !== "")
}

/** The research source the environment selects (spec R13). It never reads the corpus itself: `load` does. */
export function activeResearchSource(store: SpineStore, env: Record<string, string | undefined> = process.env): ResearchSource {
  const selected = (env[RESEARCH_SOURCE_ENV] ?? "").trim().toLowerCase()
  if (selected === "memory") {
    const local = env.NODE_ENV === "development" || env.NODE_ENV === "test"
    return local && !hostedRuntime(env) ? memoryResearchSource(store) : refusing("misconfigured")
  }
  if (selected !== "" && selected !== "postgres") return refusing("misconfigured")
  const configured = readCorpusReaderConfig(
    {
      SIKANDER_CORPUS_READER_URL: env[RESEARCH_READER_URL_ENV],
      SIKANDER_CORPUS_READER_CA: env[RESEARCH_READER_CA_ENV],
      SIKANDER_CORPUS_MAX_STALENESS_HOURS: env[RESEARCH_STALENESS_ENV],
    },
    env.NODE_ENV === "production"
  )
  if (!configured.ok) return refusing(configured.reason === "missing" ? "not_configured" : "misconfigured")
  return postgresSource(configured.config)
}

/** Test-only: end the Postgres source's pool and forget it and the log throttle. */
export async function resetResearchSourceForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("resetResearchSourceForTests is test-only")
  const previous = pgSource
  pgSource = null
  loggedAt.clear()
  if (previous) await (await previous.source.catch(() => null))?.end()
}
