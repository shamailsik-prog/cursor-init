import { NextResponse } from "next/server"
import { isClassification, type Classification } from "@/platform/p1/types"
import { callCommitteeBrain } from "@/platform/p1/internalAICaller"
import {
  IdempotencyError,
  IdempotencyCache,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type Body = {
  body?: string
  classification?: string
  purpose?: string
  partyNames?: string[]
}

export async function POST(request: Request) {
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }
  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!parsed.body || typeof parsed.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 })
  }
  if (!isClassification(parsed.classification)) {
    return NextResponse.json(
      { error: "classification must be a rank-0–4 label" },
      { status: 400 }
    )
  }
  const classification: Classification = parsed.classification
  const partyNames = Array.isArray(parsed.partyNames)
    ? parsed.partyNames.filter((n) => typeof n === "string" && n.length > 0)
    : undefined
  const purpose =
    typeof parsed.purpose === "string" ? parsed.purpose : "committee-brain"
  const fingerprint = JSON.stringify({
    route: "/api/p1/committee-brain",
    body: parsed.body,
    classification,
    purpose,
    partyNames: partyNames ?? [],
  })
  const replay = idempotency.getReplay(key, fingerprint)
  if (replay.conflict) {
    return NextResponse.json(
      { error: "Idempotency-Key reused with a different request payload" },
      { status: 409 }
    )
  }
  if (replay.body !== undefined) {
    return NextResponse.json({ result: replay.body, idempotencyKey: key, reused: true })
  }

  const result = await callCommitteeBrain({
    body: parsed.body,
    classification,
    provider: "ai-gateway",
    purpose,
    partyNames,
  })

  const payload = {
    blocked: result.blocked,
    reason: result.reason,
    text: result.text,
    outbound: result.outbound,
    agent: "sikander-ai",
  }
  idempotency.set(key, payload, fingerprint)
  return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
}
