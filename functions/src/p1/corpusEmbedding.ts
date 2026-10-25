import type { Response } from "express"
import { logger } from "firebase-functions"
import { onRequest, type Request } from "firebase-functions/v2/https"
import { isClassification } from "@/platform/p1/types"
import { errorCode, logRegisteredError } from "../log"
import { RUNTIME_DEFAULTS } from "../runtimeOptions"
import { EMBEDDING_CALL_WORST_CASE_MS, MAX_EMBEDDING_INPUT_CHARS, P1EmbeddingRequestError, callP1Embedding } from "./embedding"
import { RESERVATION_LEASE_MS, assertOperationTimeBudget } from "./gateway"
import { JWKS_TIMEOUT_MS, ServiceAuthError, verifyServiceCaller } from "./serviceAuth"

/**
 * `p1CorpusEmbedding`: the corpus service's one way to a paid embedding (FA-D3C-002, spec
 * docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, rulings R6, R9 and R10). It is not a tenant
 * entry point: no user, firm header or Idempotency-Key. A service account of the corpus service (a separate cloud
 * project, L17.12 step 65) calls it with a Google-signed OIDC ID token, and it spends the P1 ledger of the one firm its
 * deployment names (`P1_CORPUS_FIRM_ID`), never a firm the caller names.
 *
 * Two layers of authentication (R9): the function is IAM-private (`invoker: "private"`; the deployment grants
 * `roles/run.invoker` on it to the corpus service account), and the handler verifies the token itself
 * (serviceAuth.ts): audience `P1_CORPUS_AUDIENCE`, caller on `P1_CORPUS_CALLERS`. Ingress is `ALLOW_ALL` because the
 * caller is in another project; IAM and the token check are the gate.
 *
 * Contract (R10): POST, `application/json`, at most MAX_BODY_BYTES, a JSON object with exactly `operationId`, `model`,
 * `dimensions`, `input` and `classification`. Every P1 decision answers 200 with the result (`ok`, `failed` or
 * `blocked`); request faults answer 400, 401, 403, 405, 413 or 415; an unconfigured deployment 503 `not_configured`;
 * an unreadable key set 503 `identity_keys_unavailable`; anything else 500 `internal`. No provider text is returned.
 */

export const CORPUS_EMBEDDING_TIMEOUT_SECONDS = 90
export const CORPUS_EMBEDDING_MAX_INSTANCES = 2
export const MAX_BODY_BYTES = 64 * 1024
/**
 * The handler's own work around the call: the key set (two fetches at most: the cached set and one refresh), the call's
 * first reads (one round trip) and the answer. Generous; the import-time check below holds the whole request in the
 * function timeout less a 5 s margin: 59 s (the call) + 10 s + 5 s = 74 s <= 90 s.
 */
export const CORPUS_HANDLER_OVERHEAD_MS = 2 * JWKS_TIMEOUT_MS + 6_000
const MARGIN_MS = 5_000

assertOperationTimeBudget({
  callMs: EMBEDDING_CALL_WORST_CASE_MS,
  handlerMs: CORPUS_HANDLER_OVERHEAD_MS,
  marginMs: MARGIN_MS,
  timeoutMs: CORPUS_EMBEDDING_TIMEOUT_SECONDS * 1000,
})
// The reservation's lease must outlive this function's timeout by 60 s, so the reconciler never settles a live call.
if (!(RESERVATION_LEASE_MS >= CORPUS_EMBEDDING_TIMEOUT_SECONDS * 1000 + 60_000)) {
  throw new Error(`reservation lease (${RESERVATION_LEASE_MS} ms) must outlive p1CorpusEmbedding's timeout (${CORPUS_EMBEDDING_TIMEOUT_SECONDS} s) by 60 s`)
}

export type CorpusEmbeddingConfig = { firmId: string; audience: string; callers: ReadonlySet<string> }

const FIRM_ID = /^[A-Za-z0-9_-]{1,128}$/
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/
const OPERATION_ID = /^[0-9a-f]{64}$/
const BODY_KEYS = ["classification", "dimensions", "input", "model", "operationId"]

/** The deployment's configuration, read on every request; null when any part is missing or malformed (fail closed). */
export function corpusEmbeddingConfig(env: Record<string, string | undefined> = process.env): CorpusEmbeddingConfig | null {
  const firmId = (env.P1_CORPUS_FIRM_ID ?? "").trim()
  const audience = (env.P1_CORPUS_AUDIENCE ?? "").trim()
  const callers = (env.P1_CORPUS_CALLERS ?? "").split(",").map((c) => c.trim().toLowerCase()).filter((c) => c !== "")
  if (!FIRM_ID.test(firmId) || callers.length === 0 || !callers.every((c) => EMAIL.test(c))) return null
  let url: URL
  try {
    url = new URL(audience)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null
  return { firmId, audience, callers: new Set(callers) }
}

type Body = { operationId: string; model: string; dimensions: number; input: string; classification: string }

/** The request body, or null: a JSON object with exactly the five keys, each of its type and bound. */
export function parseCorpusEmbeddingBody(raw: unknown): Body | null {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_BODY_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw.toString("utf8"))
  } catch {
    return null
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const keys = Object.keys(body).sort()
  if (keys.length !== BODY_KEYS.length || keys.some((k, i) => k !== BODY_KEYS[i])) return null
  const { operationId, model, dimensions, input, classification } = body
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) return null
  if (typeof model !== "string" || model.length === 0 || model.length > 100) return null
  if (typeof dimensions !== "number" || !Number.isSafeInteger(dimensions) || dimensions <= 0) return null
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_EMBEDDING_INPUT_CHARS) return null
  if (!isClassification(classification)) return null
  return { operationId, model, dimensions, input, classification }
}

function answer(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).set("cache-control", "no-store").json(body)
}

export async function handleCorpusEmbedding(req: Request, res: Response, deps: { now: () => number } = { now: Date.now }): Promise<void> {
  if (req.method !== "POST") {
    res.set("allow", "POST")
    return answer(res, 405, { error: "method_not_allowed" })
  }
  const config = corpusEmbeddingConfig()
  if (config === null) {
    logRegisteredError("p1.corpus_embedding_not_configured", { firm: Boolean(process.env.P1_CORPUS_FIRM_ID), audience: Boolean(process.env.P1_CORPUS_AUDIENCE), callers: Boolean(process.env.P1_CORPUS_CALLERS) })
    return answer(res, 503, { error: "not_configured" })
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test(String(req.headers["content-type"] ?? ""))) return answer(res, 415, { error: "unsupported_media_type" })
  const declared = Number(req.headers["content-length"] ?? 0)
  const raw: unknown = (req as { rawBody?: unknown }).rawBody
  if (declared > MAX_BODY_BYTES || (Buffer.isBuffer(raw) && raw.length > MAX_BODY_BYTES)) return answer(res, 413, { error: "body_too_large" })

  let caller: string
  try {
    caller = (await verifyServiceCaller(req.headers.authorization, { audience: config.audience, callers: config.callers, nowMs: deps.now() })).email
  } catch (err) {
    if (!(err instanceof ServiceAuthError)) {
      logRegisteredError("p1.corpus_embedding_failed", { stage: "auth", code: errorCode(err) })
      return answer(res, 500, { error: "internal" })
    }
    logger.warn("p1.corpus_caller_refused", { code: err.code })
    return answer(res, err.status, { error: err.code === "keys_unavailable" ? "identity_keys_unavailable" : err.code })
  }

  const body = parseCorpusEmbeddingBody(raw)
  if (body === null) return answer(res, 400, { error: "invalid_request" })
  try {
    const result = await callP1Embedding(
      {
        firmId: config.firmId,
        caller,
        operationId: body.operationId,
        corpusModel: body.model,
        dimensions: body.dimensions,
        input: body.input,
        classification: body.classification as Parameters<typeof callP1Embedding>[0]["classification"],
      },
      { now: deps.now }
    )
    return answer(res, 200, result)
  } catch (err) {
    if (err instanceof P1EmbeddingRequestError) return answer(res, 400, { error: err.code })
    logRegisteredError("p1.corpus_embedding_failed", { stage: "call", code: errorCode(err) })
    return answer(res, 500, { error: "internal" })
  }
}

export const p1CorpusEmbedding = onRequest(
  {
    ...RUNTIME_DEFAULTS,
    timeoutSeconds: CORPUS_EMBEDDING_TIMEOUT_SECONDS,
    maxInstances: CORPUS_EMBEDDING_MAX_INSTANCES,
    ingressSettings: "ALLOW_ALL",
    invoker: "private",
  },
  (req, res) => handleCorpusEmbedding(req, res)
)
