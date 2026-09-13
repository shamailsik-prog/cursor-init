import { NextResponse } from "next/server"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"

const courts = loadCourts(courtsSeed)
const idempotency = new Map<string, { at: number; body: unknown }>()
const TTL_MS = 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  const key = request.headers.get("Idempotency-Key")
  if (!key) {
    return NextResponse.json(
      { error: "Idempotency-Key header required" },
      { status: 400 }
    )
  }
  const cached = idempotency.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ result: cached.body, idempotencyKey: key, reused: true })
  }

  const body = (await request.json()) as { raw?: string; courtId?: string }
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
