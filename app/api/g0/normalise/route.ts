import { NextResponse } from "next/server"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import {
  IdempotencyError,
  IdempotencyCache,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"

const courts = loadCourts(courtsSeed)
const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

export async function POST(request: Request) {
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message = err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }
  let body: { raw?: string; courtId?: string }
  try {
    body = (await request.json()) as { raw?: string; courtId?: string }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!body.raw || !body.courtId) {
    return NextResponse.json(
      { error: "raw and courtId are required" },
      { status: 400 }
    )
  }
  const fingerprint = JSON.stringify({
    route: "/api/g0/normalise",
    raw: body.raw,
    courtId: body.courtId,
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

  const result = normalise(body.raw, body.courtId, courts)
  idempotency.set(key, result, fingerprint)
  return NextResponse.json({ result, idempotencyKey: key, reused: false })
}
