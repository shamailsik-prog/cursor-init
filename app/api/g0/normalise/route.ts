import { NextResponse } from "next/server"
import { fingerprintOf } from "@/platform/http/validation"
import { withSession } from "@/platform/http/withSession"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import {
  IdempotencyError,
  beginIdempotentRequest,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"

const courts = loadCourts(courtsSeed)

export async function POST(request: Request) {
  return withSession(request, handlePost)
}

async function handlePost(request: Request) {
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
  const fingerprint = fingerprintOf({
    route: "/api/g0/normalise",
    raw: body.raw,
    courtId: body.courtId,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  const result = normalise(body.raw, body.courtId, courts)
  claim.complete(result)
  return NextResponse.json({ result, idempotencyKey: key, reused: false })
}
