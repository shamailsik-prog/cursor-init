import { NextResponse } from "next/server"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import { IdempotencyError, requireIdempotencyKey } from "@/platform/http/idempotency"

const courts = loadCourts(courtsSeed)
const idempotency = new Map<string, { at: number; body: unknown }>()
const TTL_MS = 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message = err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }
  const cached = idempotency.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ result: cached.body, idempotencyKey: key, reused: true })
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
  const result = normalise(body.raw, body.courtId, courts)
  idempotency.set(key, { at: Date.now(), body: result })
  return NextResponse.json({ result, idempotencyKey: key, reused: false })
}
