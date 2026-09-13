import { NextResponse } from "next/server"
import { IdempotencyError, requireIdempotencyKey } from "@/platform/http/idempotency"
import { recall, remember } from "@/platform/spine/session"

export function fail(err: unknown) {
  if (err instanceof IdempotencyError) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
  const message = err instanceof Error ? err.message : "request failed"
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function withIdempotency(
  request: Request,
  compute: (key: string) => Promise<unknown> | unknown
) {
  try {
    const key = requireIdempotencyKey(request)
    const cached = recall(key)
    if (cached !== undefined) {
      return NextResponse.json({ ...asObject(cached), idempotencyKey: key, reused: true })
    }
    const body = await compute(key)
    remember(key, body)
    return NextResponse.json({ ...asObject(body), idempotencyKey: key, reused: false })
  } catch (err) {
    return fail(err)
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  return { result: body }
}

export function parseLimitCursor(url: URL): { limit: number; cursor: number } {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)))
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0))
  return { limit, cursor }
}

export function page<T>(items: T[], limit: number, cursor: number) {
  const slice = items.slice(cursor, cursor + limit)
  const next = cursor + limit
  return {
    items: slice,
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  }
}
