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

const DEFAULT_FILE_TEXT =
  "%PDF-ops-audit% this payload proves ingest + workflow + court-ops + filing governance wiring."

export function OperatorAuditConsole() {
  const [partnerId, setPartnerId] = useState("partner_a")
  const [operatorId, setOperatorId] = useState("associate_a")
  const [clerkId, setClerkId] = useState("clerk_a")
  const [matterId, setMatterId] = useState("")
  const [documentId, setDocumentId] = useState("")
  const [draftId, setDraftId] = useState("")
  const [packageId, setPackageId] = useState("")
  const [fileText, setFileText] = useState(DEFAULT_FILE_TEXT)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<ApiLog[]>([])

  function appendLog(log: ApiLog) {
    setLogs((prev) => [log, ...prev])
  }

  async function runApiCall(options: ApiCallOptions): Promise<unknown> {
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
    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "string"
          ? parsed.error
          : `${options.step} failed with ${response.status}`
      throw new Error(message)
    }
    return parsed
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
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <p className="mb-1 text-xs tracking-wide uppercase">Partner actor</p>
              <Input className="rounded-none" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} />
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
