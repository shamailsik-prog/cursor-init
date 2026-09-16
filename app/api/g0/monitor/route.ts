import { NextResponse } from "next/server"
import { buildSystemStatus } from "@/lib/system-status"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const limit = url.searchParams.get("limit")
  const cursor = url.searchParams.get("cursor")
  const status = buildSystemStatus()
  return NextResponse.json({
    status,
    limit,
    cursor,
  })
}
