import { NextResponse } from "next/server"
import { fingerprintOf } from "@/platform/http/validation"
import { withSession } from "@/platform/http/withSession"
import courtsSeed from "@/data/courts.json"
import { checkPermission } from "@/platform/p5/checkPermission"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
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
  let body: { actorId?: string; raw?: string; courtId?: string }
  try {
    body = (await request.json()) as { actorId?: string; raw?: string; courtId?: string }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  // Re-audit N-2: a staff tool (partner, associate, clerk, intern), never a client. withSession
  // binds actorId to the verified caller in firebase mode; insecure-dev requests carry it.
  if (typeof body.actorId !== "string" || body.actorId === "") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  const perm = checkPermission(getRuntimeStore(), body.actorId, "normalise_case_number")
  if (!perm.allow) {
    return NextResponse.json({ error: `permission denied: ${perm.reason}` }, { status: 403 })
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
