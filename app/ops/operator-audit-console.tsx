"use client"

import { useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

type ApiLog = {
  id: string
  step: string
  method: "GET" | "POST"
  url: string
  requestBody: unknown
  status: number
  ok: boolean
  responseBody: unknown
  atIso: string
}

type ApiCallOptions = {
  step: string
  method: "GET" | "POST"
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
}

type ApiCallResult = {
  ok: boolean
  status: number
  body: unknown
}

type FilingMutation = Record<string, unknown>

const DEFAULT_FILE_TEXT =
  "%PDF-ops-audit% this payload proves ingest + workflow + court-ops + filing governance wiring."

export function OperatorAuditConsole() {
  const [partnerId, setPartnerId] = useState("partner_a")
  const [secondReviewerId, setSecondReviewerId] = useState("partner_b")
  const [operatorId, setOperatorId] = useState("associate_a")
  const [clerkId, setClerkId] = useState("clerk_a")
  const [matterId, setMatterId] = useState("")
  const [documentId, setDocumentId] = useState("")
  const [draftId, setDraftId] = useState("")
  const [packageId, setPackageId] = useState("")
  const [attestationId, setAttestationId] = useState("")
  const [disputeId, setDisputeId] = useState("")
  const [adjudicationId, setAdjudicationId] = useState("")
  const [burndownTargetHours, setBurndownTargetHours] = useState("2")
  const [rebaselineTargetHours, setRebaselineTargetHours] = useState("4")
  const [fileText, setFileText] = useState(DEFAULT_FILE_TEXT)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<ApiLog[]>([])

  function appendLog(log: ApiLog) {
    setLogs((prev) => [log, ...prev])
  }

  async function runApiCallWithStatus(options: ApiCallOptions): Promise<ApiCallResult> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === "") continue
      params.set(key, String(value))
    }
    const query = params.toString()
    const url = query ? `${options.path}?${query}` : options.path
    const headers = new Headers()
    if (options.method === "POST") {
      headers.set("Content-Type", "application/json")
      headers.set("Idempotency-Key", crypto.randomUUID())
    }
    const requestInit: RequestInit = {
      method: options.method,
      headers,
    }
    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body)
    }
    const response = await fetch(url, requestInit)
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null
    } catch {
      parsed = text
    }
    appendLog({
      id: crypto.randomUUID(),
      step: options.step,
      method: options.method,
      url,
      requestBody: options.body ?? null,
      status: response.status,
      ok: response.ok,
      responseBody: parsed,
      atIso: new Date().toISOString(),
    })
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
    }
  }

  async function runApiCall(options: ApiCallOptions): Promise<unknown> {
    const result = await runApiCallWithStatus(options)
    if (!result.ok) {
      const message =
        typeof result.body === "object" &&
        result.body !== null &&
        "error" in result.body &&
        typeof result.body.error === "string"
          ? result.body.error
          : `${options.step} failed with ${result.status}`
      throw new Error(message)
    }
    return result.body
  }

  async function runFilingAction(
    step: string,
    body: FilingMutation,
    expectedStatuses: number[] = [200]
  ) {
    const result = await runApiCallWithStatus({
      step,
      method: "POST",
      path: "/api/d4/filings",
      body,
    })
    if (!expectedStatuses.includes(result.status)) {
      throw new Error(`${step} failed with ${result.status}`)
    }
    return result.body
  }

  function firstItemIdFromBody(body: unknown): string {
    if (
      typeof body !== "object" ||
      body === null ||
      !("items" in body) ||
      !Array.isArray(body.items) ||
      !body.items[0] ||
      typeof body.items[0] !== "object" ||
      !("id" in body.items[0]) ||
      typeof body.items[0].id !== "string"
    ) {
      return ""
    }
    return body.items[0].id
  }

  async function runStep(name: string, fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${name} failed`)
    } finally {
      setBusy(false)
    }
  }

  async function seedMatter() {
    const payload = await runApiCall({
      step: "Create matter fixture",
      method: "POST",
      path: "/api/d1/matters",
      body: {
        action: "create",
        actorId: partnerId,
        firmId: "firmA",
        clientId: "client_a",
        title: `Ops audit matter ${new Date().toISOString()}`,
        courtId: "SHC",
        classification: "internal",
        memberUserIds: [operatorId, clerkId],
      },
    })
    const createdId =
      typeof payload === "object" &&
      payload !== null &&
      "result" in payload &&
      payload.result &&
      typeof payload.result === "object" &&
      "matter" in payload.result &&
      payload.result.matter &&
      typeof payload.result.matter === "object" &&
      "id" in payload.result.matter &&
      typeof payload.result.matter.id === "string"
        ? payload.result.matter.id
        : ""
    if (!createdId) throw new Error("Matter creation succeeded but matter id was missing.")
    setMatterId(createdId)
  }

  async function ingestDocument() {
    if (!matterId) throw new Error("Create a matter first.")
    const uniquePayload = `${fileText}\nrun:${crypto.randomUUID()}`
    const payload = await runApiCall({
      step: "Ingest document",
      method: "POST",
      path: "/api/d1/documents",
      body: {
        action: "ingest",
        actorId: partnerId,
        firmId: "firmA",
        matterId,
        contentBase64: btoa(uniquePayload),
        sourceChannel: "web",
        classification: "internal",
      },
    })
    const ingestedId =
      typeof payload === "object" &&
      payload !== null &&
      "result" in payload &&
      payload.result &&
      typeof payload.result === "object" &&
      "doc" in payload.result &&
      payload.result.doc &&
      typeof payload.result.doc === "object" &&
      "id" in payload.result.doc &&
      typeof payload.result.doc.id === "string"
        ? payload.result.doc.id
        : ""
    if (!ingestedId) throw new Error("Document ingestion succeeded but document id was missing.")
    setDocumentId(ingestedId)
  }

  async function transitionWorkflow() {
    if (!documentId) throw new Error("Ingest a document first.")
    await runApiCall({
      step: "Workflow transition to processing",
      method: "POST",
      path: "/api/d1/document-workflow",
      body: {
        action: "transition",
        actorId: operatorId,
        documentId,
        nextStatus: "processing",
      },
    })
  }

  async function readWorkflowQueue() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read workflow queue view",
      method: "GET",
      path: "/api/d1/document-workflow",
      query: {
        view: "queue",
        userId: operatorId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function composeDraft() {
    if (!matterId) throw new Error("Create a matter first.")
    const templates = await runApiCall({
      step: "Read draft templates",
      method: "GET",
      path: "/api/d4/drafts",
      query: {
        view: "templates",
        actorId: operatorId,
        limit: 1,
        cursor: 0,
      },
    })
    const templateId =
      typeof templates === "object" &&
      templates !== null &&
      "items" in templates &&
      Array.isArray(templates.items) &&
      templates.items[0] &&
      typeof templates.items[0] === "object" &&
      "id" in templates.items[0] &&
      typeof templates.items[0].id === "string"
        ? templates.items[0].id
        : ""
    if (!templateId) throw new Error("No draft template id available from templates view.")

    const payload = await runApiCall({
      step: "Compose draft",
      method: "POST",
      path: "/api/d4/drafts",
      body: {
        action: "compose",
        actorId: operatorId,
        matterId,
        templateId,
        title: "Ops audit draft",
        body: "Minimal draft body to exercise audited drafting API surface.",
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
    })
    const createdDraftId =
      typeof payload === "object" &&
      payload !== null &&
      "result" in payload &&
      payload.result &&
      typeof payload.result === "object" &&
      "draft" in payload.result &&
      payload.result.draft &&
      typeof payload.result.draft === "object" &&
      "id" in payload.result.draft &&
      typeof payload.result.draft.id === "string"
        ? payload.result.draft.id
        : ""
    if (!createdDraftId) throw new Error("Draft compose succeeded but draft id was missing.")
    setDraftId(createdDraftId)
  }

  async function readDrafts() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read drafts view",
      method: "GET",
      path: "/api/d4/drafts",
      query: {
        view: "drafts",
        userId: operatorId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function readCourtOpsQueue() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read court ops queue",
      method: "GET",
      path: "/api/d2/court-ops",
      query: {
        userId: operatorId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function runCourtOpsCommand() {
    await runApiCall({
      step: "Run court ops command",
      method: "POST",
      path: "/api/d2/court-ops",
      body: {
        action: "whatsapp_command",
        actorId: operatorId,
        command: "/ops queue",
      },
    })
  }

  async function createFilingPackage() {
    if (!matterId || !draftId) throw new Error("Compose a draft first.")
    const payload = await runApiCall({
      step: "Create filing package",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "create_package",
        actorId: operatorId,
        matterId,
        draftId,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
    })
    const createdPackageId =
      typeof payload === "object" &&
      payload !== null &&
      "result" in payload &&
      payload.result &&
      typeof payload.result === "object" &&
      "filingPackage" in payload.result &&
      payload.result.filingPackage &&
      typeof payload.result.filingPackage === "object" &&
      "id" in payload.result.filingPackage &&
      typeof payload.result.filingPackage.id === "string"
        ? payload.result.filingPackage.id
        : ""
    if (!createdPackageId) throw new Error("Package creation succeeded but package id was missing.")
    setPackageId(createdPackageId)
  }

  async function approveFilingPackage() {
    if (!packageId) throw new Error("Create a filing package first.")
    await runApiCall({
      step: "Approve filing package",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "decide_package",
        actorId: partnerId,
        packageId,
        decision: "approve",
        reason: "Operator audit approval to exercise governance surfaces.",
      },
    })
  }

  async function updateDispatchQueue() {
    if (!packageId) throw new Error("Create and approve a filing package first.")
    await runApiCall({
      step: "Update dispatch queue",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "dispatch_update",
        actorId: clerkId,
        packageId,
        nextStatus: "handoff_ready",
        note: "UI audit walkthrough dispatch handoff-ready transition.",
      },
    })
  }

  async function readFilingsDispatchView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read filings dispatch governance view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "dispatch",
        userId: operatorId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function readClosureComplianceView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read filings closure compliance governance view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_compliance_digests",
        userId: operatorId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function seedPhase7073AdjudicationContext() {
    if (!matterId || !packageId) {
      throw new Error("Run steps 1-10 so matter and approved package exist.")
    }

    const queueView = await runApiCall({
      step: "Read closure follow-up queue for attestation seeding",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_followup_queue",
        userId: partnerId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
    let queueId = firstItemIdFromBody(queueView)
    if (!queueId) {
      const queueViewFallback = await runApiCall({
        step: "Read closure follow-up queue fallback (firm scope)",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_followup_queue",
          userId: partnerId,
          limit: 10,
          cursor: 0,
        },
      })
      queueId = firstItemIdFromBody(queueViewFallback)
    }
    if (!queueId) {
      const attestationViewFallback = await runApiCall({
        step: "Read closure attestation fallback when queue is unavailable",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_attestations",
          userId: partnerId,
          limit: 10,
          cursor: 0,
        },
      })
      const disputeViewFallback = await runApiCall({
        step: "Read closure attestation dispute fallback when queue is unavailable",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_attestation_disputes",
          userId: partnerId,
          limit: 10,
          cursor: 0,
        },
      })
      const adjudicationViewFallback = await runApiCall({
        step: "Read closure adjudication queue fallback when queue is unavailable",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_adjudication_queue",
          userId: partnerId,
          limit: 10,
          cursor: 0,
        },
      })
      setAttestationId(firstItemIdFromBody(attestationViewFallback))
      setDisputeId(firstItemIdFromBody(disputeViewFallback))
      setAdjudicationId(firstItemIdFromBody(adjudicationViewFallback))
      return
    }

    await runApiCallWithStatus({
      step: "Assign closure follow-up queue to partner seed owner",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "assign_closure_followup",
        actorId: partnerId,
        queueId,
        assigneeId: partnerId,
        note: "Assign closure follow-up for /ops phase 70-73 seed chain",
      },
    })
    await runApiCallWithStatus({
      step: "Claim closure follow-up queue for seed chain",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "claim_closure_followup",
        actorId: partnerId,
        queueId,
        note: "Claim closure follow-up for /ops phase 70-73 seed chain",
      },
    })
    await runApiCallWithStatus({
      step: "Resolve closure follow-up queue for attestation precondition",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "resolve_closure_followup",
        actorId: partnerId,
        queueId,
        note: "Resolve closure follow-up for /ops phase 70-73 attestation seed chain",
      },
    })

    let resolvedAttestationId = attestationId
    if (!resolvedAttestationId) {
      const record = await runApiCallWithStatus({
        step: "Record closure attestation seed for phase #70-#73 actions",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "record_closure_attestation",
          actorId: partnerId,
          queueId,
          secondReviewerId,
          partnerConcurrence: true,
          evidenceNote: "Seed attestation from /ops for closure-governance action wiring.",
          note: "Operator seed for phase 70-73 adjudication context",
        },
      })
      if (
        record.ok &&
        typeof record.body === "object" &&
        record.body !== null &&
        "result" in record.body &&
        record.body.result &&
        typeof record.body.result === "object" &&
        "closureAttestation" in record.body.result &&
        record.body.result.closureAttestation &&
        typeof record.body.result.closureAttestation === "object" &&
        "id" in record.body.result.closureAttestation &&
        typeof record.body.result.closureAttestation.id === "string"
      ) {
        resolvedAttestationId = record.body.result.closureAttestation.id
      }
    }
    if (!resolvedAttestationId) {
      const attestationView = await runApiCall({
        step: "Read closure attestation view for seeded id",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_attestations",
          userId: partnerId,
          matterId,
          limit: 10,
          cursor: 0,
        },
      })
      resolvedAttestationId = firstItemIdFromBody(attestationView)
      if (!resolvedAttestationId) {
        const attestationViewFallback = await runApiCall({
          step: "Read closure attestation fallback (firm scope)",
          method: "GET",
          path: "/api/d4/filings",
          query: {
            view: "closure_attestations",
            userId: partnerId,
            limit: 10,
            cursor: 0,
          },
        })
        resolvedAttestationId = firstItemIdFromBody(attestationViewFallback)
      }
    }
    if (!resolvedAttestationId) return
    setAttestationId(resolvedAttestationId)

    let resolvedDisputeId = disputeId
    if (!resolvedDisputeId) {
      const openDispute = await runApiCallWithStatus({
        step: "Open closure attestation dispute seed",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "open_closure_attestation_dispute",
          actorId: secondReviewerId,
          attestationId: resolvedAttestationId,
          conflictReason: "Operator seed conflict for adjudication chain.",
          note: "Open dispute so adjudication queue can be exercised from /ops",
        },
      })
      if (
        openDispute.ok &&
        typeof openDispute.body === "object" &&
        openDispute.body !== null &&
        "result" in openDispute.body &&
        openDispute.body.result &&
        typeof openDispute.body.result === "object" &&
        "closureAttestationDispute" in openDispute.body.result &&
        openDispute.body.result.closureAttestationDispute &&
        typeof openDispute.body.result.closureAttestationDispute === "object" &&
        "id" in openDispute.body.result.closureAttestationDispute &&
        typeof openDispute.body.result.closureAttestationDispute.id === "string"
      ) {
        resolvedDisputeId = openDispute.body.result.closureAttestationDispute.id
      }
    }
    if (!resolvedDisputeId) {
      const disputeView = await runApiCall({
        step: "Read closure attestation dispute view for seeded id",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_attestation_disputes",
          userId: partnerId,
          matterId,
          limit: 10,
          cursor: 0,
        },
      })
      resolvedDisputeId = firstItemIdFromBody(disputeView)
      if (!resolvedDisputeId) {
        const disputeViewFallback = await runApiCall({
          step: "Read closure attestation dispute fallback (firm scope)",
          method: "GET",
          path: "/api/d4/filings",
          query: {
            view: "closure_attestation_disputes",
            userId: partnerId,
            limit: 10,
            cursor: 0,
          },
        })
        resolvedDisputeId = firstItemIdFromBody(disputeViewFallback)
      }
    }
    if (!resolvedDisputeId) return
    setDisputeId(resolvedDisputeId)

    let resolvedAdjudicationId = adjudicationId
    if (!resolvedAdjudicationId) {
      const escalate = await runApiCallWithStatus({
        step: "Escalate dispute to panel seed",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "escalate_closure_dispute_to_panel",
          actorId: secondReviewerId,
          disputeId: resolvedDisputeId,
          panelMemberIds: [partnerId, secondReviewerId],
          dissentNote: "Seed dissent note for phase #70-#73 /ops adjudication flow.",
          note: "Escalate dispute for /ops phase #70-#73 action path",
        },
      })
      if (
        escalate.ok &&
        typeof escalate.body === "object" &&
        escalate.body !== null &&
        "result" in escalate.body &&
        escalate.body.result &&
        typeof escalate.body.result === "object" &&
        "closureAdjudicationQueue" in escalate.body.result &&
        escalate.body.result.closureAdjudicationQueue &&
        typeof escalate.body.result.closureAdjudicationQueue === "object" &&
        "id" in escalate.body.result.closureAdjudicationQueue &&
        typeof escalate.body.result.closureAdjudicationQueue.id === "string"
      ) {
        resolvedAdjudicationId = escalate.body.result.closureAdjudicationQueue.id
      }
    }
    if (!resolvedAdjudicationId) {
      const adjudicationView = await runApiCall({
        step: "Read closure adjudication queue view for seeded id",
        method: "GET",
        path: "/api/d4/filings",
        query: {
          view: "closure_adjudication_queue",
          userId: partnerId,
          matterId,
          limit: 10,
          cursor: 0,
        },
      })
      resolvedAdjudicationId = firstItemIdFromBody(adjudicationView)
      if (!resolvedAdjudicationId) {
        const adjudicationViewFallback = await runApiCall({
          step: "Read closure adjudication queue fallback (firm scope)",
          method: "GET",
          path: "/api/d4/filings",
          query: {
            view: "closure_adjudication_queue",
            userId: partnerId,
            limit: 10,
            cursor: 0,
          },
        })
        resolvedAdjudicationId = firstItemIdFromBody(adjudicationViewFallback)
      }
    }
    if (!resolvedAdjudicationId) return
    setAdjudicationId(resolvedAdjudicationId)

    await runApiCallWithStatus({
      step: "Govern closure adjudication quorum seed",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "govern_closure_adjudication_quorum",
        actorId: partnerId,
        adjudicationId: resolvedAdjudicationId,
        requiredPanelCount: 2,
        quorumWindowHours: 1,
        verdictWindowHours: 1,
        note: "Quorum seed for /ops phase 70-73 action path",
      },
    })
    await runApiCallWithStatus({
      step: "Acknowledge closure adjudication SLO breach seed",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "acknowledge_closure_adjudication_slo_breach",
        actorId: partnerId,
        adjudicationId: resolvedAdjudicationId,
        note: "SLO breach seed for /ops phase 70-73 action path",
      },
    })
    await runApiCallWithStatus({
      step: "Extend closure adjudication SLO deadline seed",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "extend_closure_adjudication_slo_deadline",
        actorId: partnerId,
        adjudicationId: resolvedAdjudicationId,
        extensionHours: 2,
        note: "SLO extension seed for /ops phase 70-73 action path",
      },
    })
    await runApiCallWithStatus({
      step: "Escalate closure adjudication SLO tier seed",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "escalate_closure_adjudication_slo_tier",
        actorId: partnerId,
        adjudicationId: resolvedAdjudicationId,
        escalationTier: "tier_2_management_escalation",
        note: "SLO tier seed for /ops phase 70-73 action path",
      },
    })
    await runApiCallWithStatus({
      step: "Record closure adjudication SLO debt remediation seed",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "record_closure_adjudication_slo_debt_remediation",
        actorId: partnerId,
        adjudicationId: resolvedAdjudicationId,
        note: "Debt remediation seed for /ops phase 70-73 action path",
      },
    })
  }

  async function setClosureAdjudicationDebtBurndownTarget() {
    const selectedAdjudicationId = adjudicationId.trim() || "adjudication_missing_from_seed"
    await runApiCallWithStatus({
      step: "Set closure adjudication debt burndown target",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "set_closure_adjudication_debt_burndown_target",
        actorId: partnerId,
        adjudicationId: selectedAdjudicationId,
        targetHours: Number(burndownTargetHours),
        note: "Set from /ops phase-specific closure governance action wiring.",
      },
    })
  }

  async function rebaselineClosureAdjudicationBurndownForecast() {
    const selectedAdjudicationId = adjudicationId.trim() || "adjudication_missing_from_seed"
    await runApiCallWithStatus({
      step: "Rebaseline closure adjudication burndown forecast",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "rebaseline_closure_adjudication_burndown_forecast",
        actorId: partnerId,
        adjudicationId: selectedAdjudicationId,
        targetHours: Number(rebaselineTargetHours),
        note: "Rebaseline from /ops phase-specific closure governance action wiring.",
      },
    })
  }

  async function acknowledgeClosureBurndownSettlementDrift() {
    const selectedAdjudicationId = adjudicationId.trim() || "adjudication_missing_from_seed"
    await runApiCallWithStatus({
      step: "Acknowledge closure burndown settlement drift",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "acknowledge_closure_burndown_settlement_drift",
        actorId: partnerId,
        adjudicationId: selectedAdjudicationId,
        note: "Settlement drift acknowledgement from /ops for phase-specific action coverage.",
      },
    })
  }

  async function checkpointClosureSettlementPostResolutionVerification() {
    const selectedAdjudicationId = adjudicationId.trim() || "adjudication_missing_from_seed"
    await runApiCallWithStatus({
      step: "Checkpoint closure settlement post-resolution verification",
      method: "POST",
      path: "/api/d4/filings",
      body: {
        action: "checkpoint_closure_settlement_post_resolution_verification",
        actorId: partnerId,
        adjudicationId: selectedAdjudicationId,
        note: "Post-resolution checkpoint from /ops for phase-specific action coverage.",
      },
    })
  }

  async function readClosureAdjudicationDebtBurndownView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read closure adjudication debt burndown view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_adjudication_debt_burndown",
        userId: partnerId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function readClosureBurndownRecalibrationView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read closure burndown recalibration view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_burndown_recalibration",
        userId: partnerId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function readClosureBurndownSettlementView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read closure burndown settlement view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_burndown_settlement",
        userId: partnerId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function readClosureSettlementAttestationView() {
    if (!matterId) throw new Error("Create a matter first.")
    await runApiCall({
      step: "Read closure settlement attestation view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "closure_settlement_attestation",
        userId: partnerId,
        matterId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function runBatchEFilingEscalationActions() {
    if (!packageId) throw new Error("Create and approve a filing package first.")
    await runFilingAction("Annexure checkpoint: partner signoff", {
      action: "annexure_checkpoint",
      actorId: partnerId,
      packageId,
      checkpoint: "record_partner_signoff",
      note: "Ops Batch E: partner signoff checkpoint",
    })
    await runFilingAction("Annexure checkpoint: clerk verification", {
      action: "annexure_checkpoint",
      actorId: clerkId,
      packageId,
      checkpoint: "record_clerk_verification",
      note: "Ops Batch E: clerk verification checkpoint",
    })
    await runFilingAction("Annexure checkpoint: ready for transport", {
      action: "annexure_checkpoint",
      actorId: partnerId,
      packageId,
      checkpoint: "mark_ready_for_transport",
      note: "Ops Batch E: annexure ready for transport",
    })
    await runFilingAction("Record submission receipt", {
      action: "record_submission_receipt",
      actorId: clerkId,
      packageId,
      courtChannel: "efiling_portal_stub",
      dispatchOutcome: "retry_scheduled",
      submissionReference: "OPS-BATCH-E-SUB-001",
      failureReason: "timeout",
      retryHint: "retry after clerk callback",
      note: "Ops Batch E: deterministic submission receipt",
    })
    await runFilingAction("Reconcile submission", {
      action: "reconcile_submission",
      actorId: partnerId,
      packageId,
      status: "needs_retry",
      note: "Ops Batch E: partner reconciliation",
    })
    await runFilingAction("Claim submission exception", {
      action: "claim_submission_exception",
      actorId: clerkId,
      packageId,
      note: "Ops Batch E: clerk claimed exception",
    })
    await runFilingAction("Escalate submission exception", {
      action: "escalate_submission_exception",
      actorId: clerkId,
      packageId,
      escalationOwnerId: partnerId,
      severity: "critical",
      slaHours: 4,
      note: "Ops Batch E: escalated to partner",
    })
    await runFilingAction("Resolve submission exception", {
      action: "resolve_submission_exception",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: partner approved retry plan",
    })
    await runFilingAction("Reopen submission exception", {
      action: "reopen_submission_exception",
      actorId: partnerId,
      packageId,
      severity: "high",
      note: "Ops Batch E: reopened after follow-up feedback",
    })
    await runFilingAction("Mark transport blocked", {
      action: "mark_transport_blocked",
      actorId: clerkId,
      packageId,
      transportChannel: "efiling_portal_stub",
      channelPayloadHash: `ops-batch-e-blocked-${crypto.randomUUID()}`,
      blockerTags: ["portal_timeout", "token_expired"],
      attachmentPointers: ["ops://batch-e/retry-window-note"],
      severity: "critical",
      note: "Ops Batch E: fail-closed transport block",
    })
    await runFilingAction("Attach retry plan evidence", {
      action: "attach_retry_plan",
      actorId: partnerId,
      packageId,
      transportChannel: "operator_followup_stub",
      channelPayloadHash: `ops-batch-e-retry-${crypto.randomUUID()}`,
      attachmentPointers: ["ops://batch-e/retry-plan-v2"],
      note: "Ops Batch E: partner retry plan attached",
    })
    await runFilingAction("Acknowledge SLA breach digest", {
      action: "acknowledge_breach",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: SLA breach acknowledged",
    })
    await runFilingAction("Defer SLA breach window", {
      action: "defer_window",
      actorId: partnerId,
      packageId,
      deferHours: 6,
      note: "Ops Batch E: deferred breach window",
    })
    await runFilingAction("Assign primary escalation owner", {
      action: "assign_primary_owner",
      actorId: partnerId,
      packageId,
      primaryOwnerId: partnerId,
      activeWindowHours: 12,
      note: "Ops Batch E: primary owner assigned",
    })
    await runFilingAction("Set backup escalation owner", {
      action: "set_backup_owner",
      actorId: partnerId,
      packageId,
      backupOwnerId: partnerId,
      note: "Ops Batch E: backup owner assigned",
    })
    await runFilingAction("Acknowledge owner drift", {
      action: "acknowledge_owner_drift",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: owner drift acknowledged",
    })
    await runFilingAction("Snooze workload alert", {
      action: "snooze_workload_alert",
      actorId: partnerId,
      packageId,
      snoozeHours: 4,
      note: "Ops Batch E: workload alert snoozed",
    })
    await runFilingAction("Rebalance escalation assignment", {
      action: "rebalance_assignment",
      actorId: partnerId,
      packageId,
      newPrimaryOwnerId: partnerId,
      note: "Ops Batch E: assignment rebalanced",
    })
    await runFilingAction("Set firm policy baseline", {
      action: "set_policy_baseline",
      actorId: partnerId,
      ownerLoadThreshold: 2,
      handoffSlaHours: 2,
      waiverWindowHours: 12,
      note: "Ops Batch E: firm policy baseline set",
    })
    await runFilingAction("Set package policy baseline", {
      action: "set_policy_baseline",
      actorId: partnerId,
      packageId,
      ownerLoadThreshold: 1,
      handoffSlaHours: 1,
      waiverWindowHours: 6,
      note: "Ops Batch E: package policy baseline set",
    })
    await runFilingAction("Grant breach waiver", {
      action: "grant_breach_waiver",
      actorId: partnerId,
      packageId,
      durationHours: 2,
      reason: "Ops Batch E planned handoff coverage",
      note: "Ops Batch E: waiver granted",
    })
    await runFilingAction("Acknowledge policy variance", {
      action: "acknowledge_policy_variance",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: policy variance acknowledged",
    })
    await runFilingAction("Snooze policy variance", {
      action: "snooze_policy_variance",
      actorId: partnerId,
      packageId,
      snoozeHours: 3,
      note: "Ops Batch E: policy variance snoozed",
    })
    await runFilingAction("Record variance remediation", {
      action: "record_variance_remediation",
      actorId: partnerId,
      packageId,
      decision: "temporary_override",
      justification: "Ops Batch E controlled override while transport remains firm-gated",
      expiresInHours: 4,
      secondApproverId: partnerId,
      note: "Ops Batch E: remediation ledger entry",
    })
    await runFilingAction("Acknowledge remediation expiry digest", {
      action: "acknowledge_remediation_expiry",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: remediation expiry acknowledged",
    })
    await runFilingAction("Snooze remediation expiry digest", {
      action: "snooze_remediation_expiry",
      actorId: partnerId,
      packageId,
      snoozeHours: 2,
      note: "Ops Batch E: remediation expiry snoozed",
    })
    await runFilingAction("Attest remediation closure", {
      action: "attest_remediation_closure",
      actorId: partnerId,
      packageId,
      closureOutcome: "accepted_risk_retired",
      note: "Ops Batch E: remediation closure attested",
    })
    await runFilingAction("Acknowledge waiver expiry digest", {
      action: "acknowledge_waiver_expiry",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: waiver expiry acknowledged",
    })
    await runFilingAction("Extend breach waiver", {
      action: "extend_breach_waiver",
      actorId: partnerId,
      packageId,
      extendHours: 8,
      secondApproverId: partnerId,
      rolloverJustification: "Ops Batch E rollover required while transport remains fail-closed",
      rolloverNote: "Ops Batch E rollover attestation generated",
      note: "Ops Batch E: waiver extended",
    })
    await runFilingAction(
      "Acknowledge waiver rollover breach watch",
      {
        action: "acknowledge_rollover_breach",
        actorId: partnerId,
        packageId,
        note: "Ops Batch E: rollover breach acknowledged",
      },
      [200, 422]
    )
    await runFilingAction(
      "Reaffirm waiver rollover attestation",
      {
        action: "reaffirm_rollover_attestation",
        actorId: partnerId,
        packageId,
        note: "Ops Batch E: reaffirm rollover governance state",
      },
      [200, 404]
    )
    await runFilingAction(
      "Acknowledge rollover reaffirmation SLA",
      {
        action: "acknowledge_rollover_reaffirmation_sla",
        actorId: partnerId,
        packageId,
        note: "Ops Batch E: reaffirmation SLA acknowledged",
      },
      [200, 422]
    )
    await runFilingAction("Revoke breach waiver", {
      action: "revoke_breach_waiver",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: waiver revoked",
    })
    await runFilingAction("Acknowledge escalation handoff", {
      action: "acknowledge_handoff",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: escalation handoff acknowledged",
    })
    await runFilingAction("Confirm transport delivered evidence", {
      action: "confirm_delivered",
      actorId: partnerId,
      packageId,
      transportChannel: "courier_stub",
      channelPayloadHash: `ops-batch-e-delivered-${crypto.randomUUID()}`,
      attachmentPointers: ["ops://batch-e/proof-of-delivery"],
      relatedReceiptId: `receipt:${packageId}:1`,
      note: "Ops Batch E: deterministic delivery evidence confirmed",
    })
    await runFilingAction("Clear submission SLA digest", {
      action: "clear_digest",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: digest cleared",
    })
    await runFilingAction("Revoke escalation assignment", {
      action: "revoke_assignment",
      actorId: partnerId,
      packageId,
      note: "Ops Batch E: assignment revoked",
    })
  }

  async function readBatchEFilingEscalationViews() {
    if (!matterId || !packageId) {
      throw new Error("Run Batch E action chain first so matterId and packageId are available.")
    }
    await runApiCall({
      step: "Read Batch E dispatch view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "dispatch",
        userId: operatorId,
        matterId,
        packageId,
        dispatchStatus: "handoff_ready",
        assigneeId: clerkId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E annexures view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "annexures",
        userId: operatorId,
        matterId,
        packageId,
        annexureStatus: "ready",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E submission receipts view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "submission_receipts",
        userId: operatorId,
        matterId,
        packageId,
        dispatchOutcome: "retry_scheduled",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E submission reconciliation view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "submission_reconciliation",
        userId: operatorId,
        matterId,
        packageId,
        reconciliationStatus: "reconciled",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E submission exceptions view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "submission_exceptions",
        userId: operatorId,
        matterId,
        packageId,
        exceptionStatus: "resolved",
        severity: "high",
        escalationOwnerId: partnerId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E transport execution evidence view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "transport_execution",
        userId: operatorId,
        matterId,
        packageId,
        outcome: "confirm_delivered",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E submission SLA digest view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "submission_sla_digests",
        userId: operatorId,
        matterId,
        packageId,
        digestStatus: "cleared",
        ownerId: partnerId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E escalation owner rota view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "escalation_owner_rota",
        userId: operatorId,
        matterId,
        packageId,
        rotaStatus: "revoked",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E workload digest view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "escalation_workload_digests",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E policy baseline view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "escalation_policy_baselines",
        userId: operatorId,
        packageId,
        scope: "package_override",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E breach waiver ledger view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "breach_waiver_ledger",
        userId: operatorId,
        matterId,
        packageId,
        waiverStatus: "revoked",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E policy variance digest view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "policy_variance_digests",
        userId: operatorId,
        matterId,
        packageId,
        varianceStatus: "snoozed",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E waiver expiry digest view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "waiver_expiry_digests",
        userId: operatorId,
        matterId,
        packageId,
        expiryStatus: "cleared",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E variance remediation ledger view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "variance_remediation_ledger",
        userId: operatorId,
        matterId,
        packageId,
        remediationStatus: "closure_attested",
        decision: "temporary_override",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E waiver rollover attestation view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "waiver_rollover_attestations",
        userId: operatorId,
        matterId,
        packageId,
        rolloverStatus: "attested",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E remediation expiry digest view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "remediation_expiry_digests",
        userId: operatorId,
        matterId,
        packageId,
        expiryStatus: "cleared",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E remediation lifecycle view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "remediation_lifecycle",
        userId: operatorId,
        matterId,
        packageId,
        lifecycleStatus: "closure_attested",
        closureOutcome: "accepted_risk_retired",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E rollover breach watch view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "rollover_breach_watches",
        userId: operatorId,
        matterId,
        packageId,
        watchStatus: "cleared",
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Read Batch E rollover reaffirmation SLA view",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "rollover_reaffirmation_sla",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-8">
      <header className="space-y-3">
        <p className="text-xs tracking-[0.28em] text-[color:var(--brass)] uppercase">Legal OS · phase auditor</p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-3xl">Operator API audit console</h1>
          <Badge variant="outline" className="rounded-none">
            backend_real + frontend_real probe
          </Badge>
          <Badge variant="outline" className="rounded-none">
            transport_stub visible
          </Badge>
        </div>
        <p className="text-muted-foreground max-w-3xl text-sm">
          This route intentionally drives the audited API surfaces through real UI actions:
          documents, document workflow, drafts, court ops, and filings governance.
        </p>
        <Link
          href="/"
          className="inline-flex h-8 items-center justify-center rounded-none border border-border px-2.5 text-sm"
        >
          Back to foundation console
        </Link>
      </header>

      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>Actor + fixture inputs</CardTitle>
          <CardDescription>
            Defaults match runtime seeded users. Use the buttons below to run a deterministic walkthrough.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Partner actor</p>
              <Input className="rounded-none" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Second reviewer actor</p>
              <Input className="rounded-none" value={secondReviewerId} onChange={(e) => setSecondReviewerId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Operator actor</p>
              <Input className="rounded-none" value={operatorId} onChange={(e) => setOperatorId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Clerk actor</p>
              <Input className="rounded-none" value={clerkId} onChange={(e) => setClerkId(e.target.value)} />
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs tracking-wide uppercase">Document text payload</p>
            <textarea
              className="border-input bg-background min-h-24 w-full rounded-none border px-3 py-2 text-sm"
              value={fileText}
              onChange={(e) => setFileText(e.target.value)}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">matterId</p>
              <Input className="rounded-none font-mono text-xs" value={matterId} onChange={(e) => setMatterId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">documentId</p>
              <Input className="rounded-none font-mono text-xs" value={documentId} onChange={(e) => setDocumentId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">draftId</p>
              <Input className="rounded-none font-mono text-xs" value={draftId} onChange={(e) => setDraftId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">packageId</p>
              <Input className="rounded-none font-mono text-xs" value={packageId} onChange={(e) => setPackageId(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">attestationId</p>
              <Input className="rounded-none font-mono text-xs" value={attestationId} onChange={(e) => setAttestationId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">disputeId</p>
              <Input className="rounded-none font-mono text-xs" value={disputeId} onChange={(e) => setDisputeId(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">adjudicationId (#70-#73 path)</p>
              <Input className="rounded-none font-mono text-xs" value={adjudicationId} onChange={(e) => setAdjudicationId(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Burndown target hours</p>
              <Input className="rounded-none" value={burndownTargetHours} onChange={(e) => setBurndownTargetHours(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Rebaseline target hours</p>
              <Input className="rounded-none" value={rebaselineTargetHours} onChange={(e) => setRebaselineTargetHours(e.target.value)} />
            </div>
          </div>
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-none">
          <CardHeader>
            <CardTitle>Audited flow actions</CardTitle>
            <CardDescription>Run top-to-bottom for a full auditor walkthrough.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Matter created", seedMatter)}>
              1) Create matter fixture
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Document ingested", ingestDocument)}>
              2) Ingest document
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Workflow transitioned", transitionWorkflow)}>
              3) Transition workflow
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Workflow queue read", readWorkflowQueue)}>
              4) Read workflow queue
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Draft composed", composeDraft)}>
              5) Compose draft
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Draft list read", readDrafts)}>
              6) Read drafts view
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Court ops queue read", readCourtOpsQueue)}>
              7) Read court ops queue
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Court ops command sent", runCourtOpsCommand)}>
              8) Post court ops command
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Filing package created", createFilingPackage)}>
              9) Create filing package
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Filing package approved", approveFilingPackage)}>
              10) Approve filing package
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Dispatch queue updated", updateDispatchQueue)}>
              11) Dispatch update
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Dispatch view read", readFilingsDispatchView)}>
              12) Read filings dispatch view
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Closure compliance view read", readClosureComplianceView)}>
              13) Read filings closure compliance view
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Phase #70-#73 adjudication context seeded", seedPhase7073AdjudicationContext)}>
              14) Seed #70-#73 adjudication context
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Debt burndown target action sent", setClosureAdjudicationDebtBurndownTarget)}>
              15) Action: set_closure_adjudication_debt_burndown_target
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Burndown rebaseline action sent", rebaselineClosureAdjudicationBurndownForecast)}>
              16) Action: rebaseline_closure_adjudication_burndown_forecast
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Settlement drift action sent", acknowledgeClosureBurndownSettlementDrift)}>
              17) Action: acknowledge_closure_burndown_settlement_drift
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Settlement post-resolution action sent", checkpointClosureSettlementPostResolutionVerification)}>
              18) Action: checkpoint_closure_settlement_post_resolution_verification
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Debt burndown view read", readClosureAdjudicationDebtBurndownView)}>
              19) View: closure_adjudication_debt_burndown
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Burndown recalibration view read", readClosureBurndownRecalibrationView)}>
              20) View: closure_burndown_recalibration
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Burndown settlement view read", readClosureBurndownSettlementView)}>
              21) View: closure_burndown_settlement
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Settlement attestation view read", readClosureSettlementAttestationView)}>
              22) View: closure_settlement_attestation
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch E filing/escalation actions executed", runBatchEFilingEscalationActions)}>
              23) Batch E actions (#48-#59): filing + escalation chain
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch E filing/escalation views read", readBatchEFilingEscalationViews)}>
              24) Batch E views (#48-#59): filings + digests + remediation + rollover
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle>API call logs</CardTitle>
            <CardDescription>
              Every button press stores request and response JSON for audit traceability.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[740px] border border-border p-3">
              <div className="space-y-3">
                {logs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No calls yet.</p>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="space-y-2 border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="rounded-none" variant={log.ok ? "default" : "destructive"}>
                          {log.status}
                        </Badge>
                        <p className="text-sm font-medium">{log.step}</p>
                        <p className="text-muted-foreground text-xs">{log.atIso}</p>
                      </div>
                      <p className="font-mono text-xs">{log.method} {log.url}</p>
                      <Separator />
                      <p className="text-xs font-medium tracking-wide uppercase">Request</p>
                      <pre className="bg-muted overflow-auto p-2 text-xs whitespace-pre-wrap">
                        {JSON.stringify(log.requestBody, null, 2)}
                      </pre>
                      <p className="text-xs font-medium tracking-wide uppercase">Response</p>
                      <pre className="bg-muted overflow-auto p-2 text-xs whitespace-pre-wrap">
                        {JSON.stringify(log.responseBody, null, 2)}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
