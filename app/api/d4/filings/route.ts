import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  createFilingPackage,
  decideFilingPackage,
} from "@/services/d4-3/filingPackage"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type CreateBody = {
  action: "create_package"
  actorId?: string
  matterId?: string
  draftId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: Array<{
    sectionId: string
    offenceDate: string
    usedText: string
  }>
  partnerOverride?: {
    partnerId?: string
    reason?: string
  }
}

type DecideBody = {
  action: "decide_package"
  actorId?: string
  packageId?: string
  decision?: "approve" | "reject"
  reason?: string
}

type Body = CreateBody | DecideBody

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 25
  if (!Number.isFinite(parsed) || parsed < 1) return 25
  return Math.min(parsed, 100)
}

function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    const user = store.users.get(userId)
    if (!user) {
      return NextResponse.json({ error: "unknown user" }, { status: 404 })
    }
    const firmPackages = await repos.filings.listByFirm(user.firmId)
    const visible = firmPackages
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => {
        const permission = checkPermission(store, user.id, "draft", row.matterId)
        if (!permission.allow) return false
        return rankOf(user.clearanceLevel) >= rankOf(row.classification)
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    const items = visible.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + items.length < visible.length ? String(cursor + items.length) : null
    return NextResponse.json({
      items,
      total: visible.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filings read failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
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
  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d4/filings",
    action: parsed.action,
    body: parsed,
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

  try {
    if (parsed.action === "create_package") {
      if (
        !parsed.actorId ||
        !parsed.matterId ||
        !parsed.draftId ||
        !isClassification(parsed.classification)
      ) {
        return NextResponse.json(
          { error: "actorId, matterId, draftId, and classification are required" },
          { status: 400 }
        )
      }
      const partnerOverride =
        parsed.partnerOverride?.partnerId || parsed.partnerOverride?.reason
          ? {
              partnerId: parsed.partnerOverride?.partnerId ?? "",
              reason: parsed.partnerOverride?.reason ?? "",
            }
          : undefined
      const created = createFilingPackage(store, {
        actorId: parsed.actorId,
        matterId: parsed.matterId,
        draftId: parsed.draftId,
        preflight: {
          actorId: parsed.actorId,
          matterId: parsed.matterId,
          classification: parsed.classification,
          citedJudgmentIds: parsed.citedJudgmentIds ?? [],
          temporalCitations: parsed.temporalCitations ?? [],
          partnerOverride,
        },
      })
      await repos.filings.create(created.filingPackage)
      const payload = {
        action: "create_package",
        filingPackage:
          (await repos.filings.get(created.filingPackage.id)) ?? created.filingPackage,
        preflight: created.preflight,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "decide_package") {
      if (!parsed.actorId || !parsed.packageId || !parsed.decision || !parsed.reason) {
        return NextResponse.json(
          { error: "actorId, packageId, decision, and reason are required" },
          { status: 400 }
        )
      }
      const filingPackage = decideFilingPackage(store, {
        actorId: parsed.actorId,
        packageId: parsed.packageId,
        decision: parsed.decision,
        reason: parsed.reason,
      })
      const persisted = await repos.filings.get(filingPackage.id)
      if (persisted) {
        await repos.filings.update(filingPackage.id, {
          status: filingPackage.status,
          approvedBy: filingPackage.approvedBy,
          approvalReason: filingPackage.approvalReason,
        })
      } else {
        await repos.filings.create(filingPackage)
      }
      const payload = {
        action: "decide_package",
        filingPackage: (await repos.filings.get(filingPackage.id)) ?? filingPackage,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filing package write failed"
    const status = /preflight blocked/.test(message) ? 422 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
