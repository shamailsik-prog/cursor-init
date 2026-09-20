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
  const [rebalanceId, setRebalanceId] = useState("")
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

  async function runBatchEActionLattice() {
    if (!matterId || !packageId) throw new Error("Run steps 1-10 so matter/package are available.")
    const allowed = [200, 403, 404, 422]

    await runApiCallAllowingStatuses(
      {
        step: "Batch E: annexure checkpoint partner signoff",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "annexure_checkpoint",
          actorId: partnerId,
          packageId,
          checkpoint: "record_partner_signoff",
          note: "Batch E /ops wiring: partner signoff checkpoint",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: annexure checkpoint clerk verification",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "annexure_checkpoint",
          actorId: clerkId,
          packageId,
          checkpoint: "record_clerk_verification",
          note: "Batch E /ops wiring: clerk verification checkpoint",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: annexure checkpoint mark ready for transport",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "annexure_checkpoint",
          actorId: partnerId,
          packageId,
          checkpoint: "mark_ready_for_transport",
          note: "Batch E /ops wiring: mark annexure ready for transport",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: record submission receipt",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "record_submission_receipt",
          actorId: clerkId,
          packageId,
          courtChannel: "efiling_portal_stub",
          dispatchOutcome: "retry_scheduled",
          submissionReference: `ops-${packageId.slice(0, 8)}-${Date.now()}`,
          failureReason: "network timeout",
          retryHint: "retry after supervisor check",
          note: "Batch E /ops wiring: deterministic submission receipt capture",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: reconcile submission",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "reconcile_submission",
          actorId: partnerId,
          packageId,
          status: "needs_retry",
          note: "Batch E /ops wiring: reconcile deterministic submission outcome",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: claim submission exception",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "claim_submission_exception",
          actorId: clerkId,
          packageId,
          note: "Batch E /ops wiring: claim submission exception",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: escalate submission exception",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "escalate_submission_exception",
          actorId: clerkId,
          packageId,
          escalationOwnerId: partnerId,
          severity: "critical",
          slaHours: 3,
          note: "Batch E /ops wiring: escalate exception to partner",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: resolve submission exception",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "resolve_submission_exception",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: resolve escalated exception",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: reopen submission exception",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "reopen_submission_exception",
          actorId: partnerId,
          packageId,
          severity: "high",
          note: "Batch E /ops wiring: reopen exception for follow-up",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: mark transport blocked",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "mark_transport_blocked",
          actorId: clerkId,
          packageId,
          transportChannel: "efiling_portal_stub",
          channelPayloadHash: `ops-hash-${Date.now()}`,
          blockerTags: ["portal_timeout", "token_expired"],
          attachmentPointers: ["ops://dispatch/retry-window-note"],
          severity: "critical",
          note: "Batch E /ops wiring: blocked transport evidence",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: attach retry plan",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "attach_retry_plan",
          actorId: partnerId,
          packageId,
          transportChannel: "operator_followup_stub",
          channelPayloadHash: `ops-retry-${Date.now()}`,
          attachmentPointers: ["ops://dispatch/retry-plan-v2"],
          note: "Batch E /ops wiring: attach retry plan",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: acknowledge SLA breach",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_breach",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: acknowledge breach",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: defer SLA window",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "defer_window",
          actorId: partnerId,
          packageId,
          deferHours: 6,
          note: "Batch E /ops wiring: defer window",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: assign primary owner",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "assign_primary_owner",
          actorId: partnerId,
          packageId,
          primaryOwnerId: partnerId,
          activeWindowHours: 12,
          note: "Batch E /ops wiring: assign primary owner",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: set backup owner",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "set_backup_owner",
          actorId: partnerId,
          packageId,
          backupOwnerId: partnerId,
          note: "Batch E /ops wiring: set backup owner",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: acknowledge owner drift",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_owner_drift",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: acknowledge owner drift",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: snooze workload alert",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "snooze_workload_alert",
          actorId: partnerId,
          packageId,
          snoozeHours: 4,
          note: "Batch E /ops wiring: snooze workload alert",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: rebalance assignment",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "rebalance_assignment",
          actorId: partnerId,
          packageId,
          newPrimaryOwnerId: partnerId,
          note: "Batch E /ops wiring: rebalance assignment",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: set firm policy baseline",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "set_policy_baseline",
          actorId: partnerId,
          ownerLoadThreshold: 2,
          handoffSlaHours: 2,
          waiverWindowHours: 12,
          note: "Batch E /ops wiring: set firm policy baseline",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: set package policy baseline",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "set_policy_baseline",
          actorId: partnerId,
          packageId,
          ownerLoadThreshold: 1,
          handoffSlaHours: 1,
          waiverWindowHours: 6,
          note: "Batch E /ops wiring: set package policy baseline override",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: grant breach waiver",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "grant_breach_waiver",
          actorId: partnerId,
          packageId,
          durationHours: 2,
          reason: "Temporary registry closure and staffing rotation",
          note: "Batch E /ops wiring: grant breach waiver",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: acknowledge policy variance",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_policy_variance",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: acknowledge policy variance",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: snooze policy variance",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "snooze_policy_variance",
          actorId: partnerId,
          packageId,
          snoozeHours: 3,
          note: "Batch E /ops wiring: snooze policy variance",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: record variance remediation",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "record_variance_remediation",
          actorId: partnerId,
          packageId,
          decision: "temporary_override",
          justification: "Controlled override while transport backlog resolves",
          expiresInHours: 4,
          secondApproverId: partnerId,
          note: "Batch E /ops wiring: record variance remediation",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: acknowledge waiver expiry",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_waiver_expiry",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: acknowledge waiver expiry",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: extend breach waiver",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "extend_breach_waiver",
          actorId: partnerId,
          packageId,
          extendHours: 8,
          secondApproverId: partnerId,
          rolloverJustification: "Waiver cap exceeded due documented closure period",
          rolloverNote: "Rollover attestation captured with partner signoff",
          note: "Batch E /ops wiring: extend breach waiver",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: acknowledge handoff",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_handoff",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: acknowledge handoff",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: confirm delivered",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "confirm_delivered",
          actorId: partnerId,
          packageId,
          transportChannel: "courier_stub",
          channelPayloadHash: `ops-delivered-${Date.now()}`,
          attachmentPointers: ["ops://dispatch/proof-of-delivery"],
          relatedReceiptId: `receipt:${packageId}:1`,
          note: "Batch E /ops wiring: confirm delivered",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: clear SLA digest",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "clear_digest",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: clear digest",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: revoke assignment",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "revoke_assignment",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: revoke assignment",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch E: revoke breach waiver",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "revoke_breach_waiver",
          actorId: partnerId,
          packageId,
          note: "Batch E /ops wiring: revoke breach waiver",
        },
      },
      allowed
    )
  }

  async function readBatchEGovernanceViews() {
    if (!matterId || !packageId) throw new Error("Run steps 1-10 so matter/package are available.")
    await runApiCall({
      step: "Batch E view: annexures",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "annexures", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: submission receipts",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "submission_receipts", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: submission reconciliation",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "submission_reconciliation",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Batch E view: submission exceptions",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "submission_exceptions", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: transport execution",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "transport_execution", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: submission SLA digests",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "submission_sla_digests", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: escalation owner rota",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "escalation_owner_rota", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: escalation workload digests",
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
      step: "Batch E view: escalation policy baselines",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "escalation_policy_baselines",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Batch E view: breach waiver ledger",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "breach_waiver_ledger", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: policy variance digests",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "policy_variance_digests", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: waiver expiry digests",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "waiver_expiry_digests", userId: operatorId, matterId, packageId, limit: 10, cursor: 0 },
    })
    await runApiCall({
      step: "Batch E view: variance remediation ledger",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "variance_remediation_ledger",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
    await runApiCall({
      step: "Batch E view: waiver rollover attestations",
      method: "GET",
      path: "/api/d4/filings",
      query: {
        view: "waiver_rollover_attestations",
        userId: operatorId,
        matterId,
        packageId,
        limit: 10,
        cursor: 0,
      },
    })
  }

  async function runBatchFGovernanceLattice() {
    if (!matterId || !packageId) throw new Error("Run steps 1-10 so matter/package are available.")
    const allowed = [200, 403, 404, 422]

    await runApiCallAllowingStatuses(
      {
        step: "Batch F: set closure SLA window config",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "set_closure_sla_window_config",
          actorId: partnerId,
          ackDeadlineHours: 1,
          clearDeadlineHours: 2,
          autoEscalationHours: 3,
          note: "Batch F /ops wiring: set closure SLA windows",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: set closure auto assignment rule",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "set_closure_auto_assignment_rule",
          actorId: partnerId,
          mode: "workload_aware_claim",
          maxActiveClaimsPerPartner: 4,
          note: "Batch F /ops wiring: set closure auto assignment rule",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: assign closure follow-up",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "assign_closure_followup",
          actorId: partnerId,
          ownerId: partnerId,
          assigneeId: partnerId,
          note: "Batch F /ops wiring: assign closure follow-up",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: auto-assign closure follow-up",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "auto_assign_closure_followup",
          actorId: partnerId,
          ownerId: partnerId,
          note: "Batch F /ops wiring: auto-assign closure follow-up",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: claim closure follow-up",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "claim_closure_followup",
          actorId: partnerId,
          ownerId: partnerId,
          note: "Batch F /ops wiring: claim closure follow-up",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: waive closure SLA exception",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "waive_closure_sla_exception",
          actorId: partnerId,
          ownerId: partnerId,
          waiverReason: "Temporary policy override during closure reconciliation",
          waiverHours: 4,
          note: "Batch F /ops wiring: waive closure SLA exception",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: acknowledge remediation expiry",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "acknowledge_remediation_expiry",
          actorId: partnerId,
          packageId,
          note: "Batch F /ops wiring: acknowledge remediation expiry",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: snooze remediation expiry",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "snooze_remediation_expiry",
          actorId: partnerId,
          packageId,
          snoozeHours: 2,
          note: "Batch F /ops wiring: snooze remediation expiry",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: attest remediation closure",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "attest_remediation_closure",
          actorId: partnerId,
          packageId,
          closureOutcome: "accepted_risk_retired",
          note: "Batch F /ops wiring: attest remediation closure",
        },
      },
      allowed
    )
    await runApiCallAllowingStatuses(
      {
        step: "Batch F: resolve closure follow-up",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "resolve_closure_followup",
          actorId: partnerId,
          ownerId: partnerId,
          note: "Batch F /ops wiring: resolve closure follow-up",
        },
      },
      allowed
    )

    let resolvedAttestationId = attestationId
    const recordAttestation = await runApiCallAllowingStatuses(
      {
        step: "Batch F: record closure attestation",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "record_closure_attestation",
          actorId: partnerId,
          ownerId: partnerId,
          secondReviewerId,
          partnerConcurrence: true,
          evidenceNote: "Batch F /ops wiring evidence bundle",
          note: "Batch F /ops wiring: record closure attestation",
        },
      },
      allowed
    )
    if (
      recordAttestation.ok &&
      typeof recordAttestation.body === "object" &&
      recordAttestation.body !== null &&
      "result" in recordAttestation.body &&
      recordAttestation.body.result &&
      typeof recordAttestation.body.result === "object" &&
      "closureAttestation" in recordAttestation.body.result &&
      recordAttestation.body.result.closureAttestation &&
      typeof recordAttestation.body.result.closureAttestation === "object" &&
      "id" in recordAttestation.body.result.closureAttestation &&
      typeof recordAttestation.body.result.closureAttestation.id === "string"
    ) {
      resolvedAttestationId = recordAttestation.body.result.closureAttestation.id
      setAttestationId(resolvedAttestationId)
    }
    if (resolvedAttestationId) {
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: review closure attestation",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "review_closure_attestation",
            actorId: secondReviewerId,
            attestationId: resolvedAttestationId,
            decision: "approve",
            note: "Batch F /ops wiring: second review approval",
          },
        },
        allowed
      )
    }

    let resolvedDisputeId = disputeId
    if (resolvedAttestationId) {
      const openDispute = await runApiCallAllowingStatuses(
        {
          step: "Batch F: open closure attestation dispute",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "open_closure_attestation_dispute",
            actorId: secondReviewerId,
            attestationId: resolvedAttestationId,
            conflictReason: "Dispute raised for chronology reconciliation",
            note: "Batch F /ops wiring: open dispute",
          },
        },
        allowed
      )
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
        setDisputeId(resolvedDisputeId)
      }
    }

    let resolvedAdjudicationId = adjudicationId
    if (resolvedDisputeId) {
      const escalateDispute = await runApiCallAllowingStatuses(
        {
          step: "Batch F: escalate dispute to panel",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "escalate_closure_dispute_to_panel",
            actorId: secondReviewerId,
            disputeId: resolvedDisputeId,
            panelMemberIds: [partnerId, secondReviewerId],
            dissentNote: "preserve immutable dissent note for review",
            note: "Batch F /ops wiring: escalate dispute to panel",
          },
        },
        allowed
      )
      if (
        escalateDispute.ok &&
        typeof escalateDispute.body === "object" &&
        escalateDispute.body !== null &&
        "result" in escalateDispute.body &&
        escalateDispute.body.result &&
        typeof escalateDispute.body.result === "object" &&
        "closureAdjudicationQueue" in escalateDispute.body.result &&
        escalateDispute.body.result.closureAdjudicationQueue &&
        typeof escalateDispute.body.result.closureAdjudicationQueue === "object" &&
        "id" in escalateDispute.body.result.closureAdjudicationQueue &&
        typeof escalateDispute.body.result.closureAdjudicationQueue.id === "string"
      ) {
        resolvedAdjudicationId = escalateDispute.body.result.closureAdjudicationQueue.id
        setAdjudicationId(resolvedAdjudicationId)
      }
    }

    if (resolvedAdjudicationId) {
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: govern closure adjudication quorum",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "govern_closure_adjudication_quorum",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            requiredPanelCount: 3,
            quorumWindowHours: 0,
            verdictWindowHours: 0,
            note: "Batch F /ops wiring: govern quorum",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: acknowledge adjudication SLO breach",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "acknowledge_closure_adjudication_slo_breach",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            note: "Batch F /ops wiring: acknowledge SLO breach",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: extend adjudication SLO deadline",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "extend_closure_adjudication_slo_deadline",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            extensionHours: 2,
            note: "Batch F /ops wiring: extend SLO deadline",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: escalate adjudication SLO tier",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "escalate_closure_adjudication_slo_tier",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            escalationTier: "tier_2_management_escalation",
            note: "Batch F /ops wiring: escalate SLO tier",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: record adjudication SLO debt remediation",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "record_closure_adjudication_slo_debt_remediation",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            note: "Batch F /ops wiring: record SLO debt remediation",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: downshift adjudication SLO tier",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "downshift_closure_adjudication_slo_tier",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            escalationTier: "tier_1_partner_watch",
            note: "Batch F /ops wiring: downshift SLO tier",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: record adjudication verdict",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "record_closure_adjudication_verdict",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            verdict: "uphold_dispute",
            dissentNote: "immutable dissent retained with verdict",
            note: "Batch F /ops wiring: record verdict",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: attest adjudication SLO breach closure",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "attest_closure_adjudication_slo_breach_closure",
            actorId: partnerId,
            adjudicationId: resolvedAdjudicationId,
            note: "Batch F /ops wiring: attest SLO breach closure",
          },
        },
        allowed
      )
    }

    await runApiCallAllowingStatuses(
      {
        step: "Batch F: tick closure SLA exception enforcement",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "tick_closure_sla_exception_enforcement",
          actorId: partnerId,
          ownerId: partnerId,
          note: "Batch F /ops wiring: tick exception enforcement",
        },
      },
      [200, 404]
    )

    let resolvedRebalanceId = rebalanceId
    const rebalance = await runApiCallAllowingStatuses(
      {
        step: "Batch F: rebalance closure enforcement queue",
        method: "POST",
        path: "/api/d4/filings",
        body: {
          action: "rebalance_closure_enforcement_queue",
          actorId: partnerId,
          ownerId: partnerId,
          status: "owner_reassignment_recommended",
          recommendedOwnerId: secondReviewerId,
          note: "Batch F /ops wiring: recommend owner reassignment",
        },
      },
      allowed
    )
    if (
      rebalance.ok &&
      typeof rebalance.body === "object" &&
      rebalance.body !== null &&
      "result" in rebalance.body &&
      rebalance.body.result &&
      typeof rebalance.body.result === "object" &&
      "closureEnforcementRebalance" in rebalance.body.result &&
      rebalance.body.result.closureEnforcementRebalance &&
      typeof rebalance.body.result.closureEnforcementRebalance === "object" &&
      "id" in rebalance.body.result.closureEnforcementRebalance &&
      typeof rebalance.body.result.closureEnforcementRebalance.id === "string"
    ) {
      resolvedRebalanceId = rebalance.body.result.closureEnforcementRebalance.id
      setRebalanceId(resolvedRebalanceId)
    }

    if (resolvedRebalanceId) {
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: configure closure rebalance safeguard",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "configure_closure_rebalance_auto_execution_safeguard",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            cooldownLockHours: 1,
            duplicateSuppressionHours: 1,
            note: "Batch F /ops wiring: configure rebalance safeguard",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: set safeguard override expiry",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "set_closure_rebalance_safeguard_override_expiry",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            overrideExpiryHours: 1,
            note: "Batch F /ops wiring: set safeguard override expiry",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: execute rebalance owner transfer",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "execute_closure_rebalance_owner_transfer",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            note: "Batch F /ops wiring: execute owner transfer",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: attest rebalance auto-execution override",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "attest_closure_rebalance_auto_execution_override",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            reason: "Controlled partner override after safeguard lockout validation",
            note: "Batch F /ops wiring: attest rebalance override",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: auto-clear safeguard suppression",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "auto_clear_closure_rebalance_safeguard_suppression",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            note: "Batch F /ops wiring: auto-clear safeguard suppression",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: cleanup stale safeguard lock",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "cleanup_stale_closure_rebalance_safeguard_lock",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            note: "Batch F /ops wiring: cleanup stale safeguard lock",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: acknowledge safeguard expiry attestation",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "acknowledge_closure_safeguard_expiry_attestation",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            note: "Batch F /ops wiring: acknowledge safeguard expiry attestation",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: queue safeguard overdue expiry exception",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "queue_closure_safeguard_overdue_expiry_exception",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            note: "Batch F /ops wiring: queue overdue expiry exception",
          },
        },
        allowed
      )
      await runApiCallAllowingStatuses(
        {
          step: "Batch F: reconcile safeguard expiry override",
          method: "POST",
          path: "/api/d4/filings",
          body: {
            action: "reconcile_closure_safeguard_expiry_override",
            actorId: partnerId,
            rebalanceId: resolvedRebalanceId,
            reconciliationNote: "Override expiry reconciled with follow-up governance notes",
            note: "Batch F /ops wiring: reconcile expiry override",
          },
        },
        allowed
      )
    }
  }

  async function readBatchFGovernanceViews() {
    if (!matterId) throw new Error("Create a matter first.")
    const baseQuery = {
      userId: partnerId,
      matterId,
      packageId: packageId || undefined,
      limit: 10,
      cursor: 0,
    }
    await runApiCall({
      step: "Batch F view: closure compliance digests",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_compliance_digests", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure follow-up queue",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_followup_queue", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure attestations",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_attestations", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure SLA window configs",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_sla_window_configs", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure auto assignment rules",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_auto_assignment_rules", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure SLA windows",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_sla_windows", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure SLA exception digests",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_sla_exception_digests", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure attestation disputes",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_attestation_disputes", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure SLA exception enforcement",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_sla_exception_enforcement", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure adjudication queue",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_adjudication_queue", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure enforcement rebalance",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_enforcement_rebalance", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure adjudication quorum",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_adjudication_quorum", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure rebalance execution",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_rebalance_execution", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure adjudication SLO",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_adjudication_slo", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure rebalance safeguards",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_rebalance_safeguards", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure adjudication SLO debt remediation",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_adjudication_slo_debt_remediation", ...baseQuery },
    })
    await runApiCall({
      step: "Batch F view: closure rebalance safeguard expiry",
      method: "GET",
      path: "/api/d4/filings",
      query: { view: "closure_rebalance_safeguard_expiry", ...baseQuery },
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
          <div className="grid gap-3 md:grid-cols-4">
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
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">rebalanceId (#60-#69 path)</p>
              <Input className="rounded-none font-mono text-xs" value={rebalanceId} onChange={(e) => setRebalanceId(e.target.value)} />
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
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch E action lattice executed", runBatchEActionLattice)}>
              23) Batch E actions (#48-#59 filing/escalation lattice)
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch E governance views read", readBatchEGovernanceViews)}>
              24) Batch E views (#48-#59 governance reads)
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch F governance action lattice executed", runBatchFGovernanceLattice)}>
              25) Batch F actions (#60-#69 governance lattice)
            </Button>
            <Button className="w-full rounded-none" disabled={busy} onClick={() => runStep("Batch F governance views read", readBatchFGovernanceViews)}>
              26) Batch F views (#60-#69 closure governance reads)
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
