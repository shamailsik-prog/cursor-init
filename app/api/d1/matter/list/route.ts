import { NextResponse } from "next/server"
import { page, parseLimitCursor } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { listMattersForUser } from "@/services/d1-2/matters"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const { limit, cursor } = parseLimitCursor(url)
  const userId = url.searchParams.get("userId") ?? "user_clerk"
  const store = getStore()
  const items = listMattersForUser(store, userId).map((m) => ({
    id: m.id,
    title: m.title,
    courtId: m.courtId,
    caseNumber: m.caseNumber,
    status: m.status,
    classification: m.classification,
  }))
  return NextResponse.json(page(items, limit, cursor))
}
