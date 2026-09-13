"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Matter = {
  id: string
  title: string
  courtId: string
  caseNumber: string | null
  status: string
  classification: string
}

function newKey() {
  return crypto.randomUUID()
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? "Request failed")
  return json
}

function post<T>(path: string, body: unknown) {
  return api<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": newKey(),
    },
    body: JSON.stringify(body),
  })
}

export function CommandDesk() {
  const [tab, setTab] = useState("desk")
  const [userId, setUserId] = useState("user_clerk")
  const [matters, setMatters] = useState<Matter[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string>("")

  const [title, setTitle] = useState("Suit for declaration — Karachi")
  const [fileText, setFileText] = useState("Order dated 10 Sep 2026 — for filing.")
  const [rawNumber, setRawNumber] = useState("C.P. No. D-1234 of 2025")
  const [cnicName, setCnicName] = useState("Muhammad Ali")
  const [cnic, setCnic] = useState("4210112345671")
  const [phone, setPhone] = useState("03009998877")
  const [wa, setWa] = useState("/matters")
  const [translateText, setTranslateText] = useState("Counsel’s privileged opinion for the client.")
  const [classification, setClassification] = useState("privileged")

  const loadMatters = useCallback(async () => {
    setError(null)
    try {
      const data = await api<{ items: Matter[]; error?: string }>(
        `/api/d1/matter/list?userId=${encodeURIComponent(userId)}&limit=20&cursor=0`
      )
      setMatters(data.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load matters")
      setMatters([])
    }
  }, [userId])

  useEffect(() => {
    void loadMatters()
  }, [loadMatters])

  function show(label: string, value: unknown) {
    setLog(`${label}\n${JSON.stringify(value, null, 2)}`)
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      show(label, result)
      await loadMatters()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-[color:var(--brass)]/35 bg-[color:var(--ink)] text-[color:var(--paper)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:flex-row md:items-end md:justify-between md:px-8">
          <div>
            <p className="text-[11px] tracking-[0.28em] text-[color:var(--brass)] uppercase">
              NHS Legal · Karachi
            </p>
            <h1 className="font-heading mt-2 text-3xl tracking-tight md:text-4xl">
              SIKANDER AI
            </h1>
            <p className="mt-2 max-w-xl text-sm text-[color:var(--paper)]/75">
              Litigation operating system. This desk is live on the G-1 spine:
              matters, files, parties, WhatsApp, and citation gates. Court fee is
              MANUAL — do not compute. L17.9 REMOVED by E-15 (8 Sep 2026).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-none border-[color:var(--brass)] bg-transparent text-[color:var(--brass)]">
              G-0 PASS
            </Badge>
            <Badge className="rounded-none border-[color:var(--brass)] bg-transparent text-[color:var(--brass)]">
              G-1 PASS
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 md:px-8">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <label className="text-xs tracking-wide uppercase">Acting as</label>
          <select
            className="border-input h-9 rounded-none border bg-transparent px-2 text-sm"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="user_clerk">Clerk</option>
            <option value="user_shamail">Partner</option>
            <option value="user_client">Client (own matters only)</option>
          </select>
          <Button
            className="rounded-none md:ml-auto"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run("Reset demo firm", () => post("/api/platform/spine/reset", {}))
            }
          >
            Reset demo
          </Button>
        </div>

        {error ? (
          <p className="border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="line" className="h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="desk" className="rounded-none">
              Desk
            </TabsTrigger>
            <TabsTrigger value="file" className="rounded-none">
              File
            </TabsTrigger>
            <TabsTrigger value="parties" className="rounded-none">
              Parties
            </TabsTrigger>
            <TabsTrigger value="channel" className="rounded-none">
              WhatsApp
            </TabsTrigger>
            <TabsTrigger value="gates" className="rounded-none">
              Gates
            </TabsTrigger>
          </TabsList>

          <TabsContent value="desk" className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Matters</CardTitle>
                <CardDescription>
                  Membership is the only access. A client sees own matters. No
                  role exempts a non-member.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {matters.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No matters for this user. Switch role or open a matter.
                  </p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {matters.map((m) => (
                      <li key={m.id} className="border border-border p-3">
                        <p className="font-medium">{m.title}</p>
                        <p className="text-muted-foreground font-mono text-xs">
                          {m.courtId} · {m.caseNumber ?? "number pending"} · {m.status} ·{" "}
                          {m.classification}
                        </p>
                        <Button
                          className="mt-2 rounded-none"
                          size="sm"
                          disabled={busy || m.status === "live"}
                          onClick={() =>
                            run("Engagement", () =>
                              post("/api/d1/matter/confirmEngagement", {
                                matterId: m.id,
                                advanceHours: 24,
                              })
                            )
                          }
                        >
                          Confirm engagement (then 24h silence)
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Open a matter</CardTitle>
                <CardDescription>
                  Engagement is unconfirmed until you say the client has instructed.
                  Accounts is not notified before that.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  className="rounded-none"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Button
                  className="rounded-none"
                  disabled={busy || !title.trim()}
                  onClick={() =>
                    run("Create matter", () =>
                      post("/api/d1/matter/create", { title, courtId: "SHC" })
                    )
                  }
                >
                  Open matter
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="file" className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Upload</CardTitle>
                <CardDescription>
                  Same bytes + firm = one document, reused: true, one OCR job.
                  Classification required.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  className="border-input min-h-28 w-full rounded-none border p-2 text-sm"
                  value={fileText}
                  onChange={(e) => setFileText(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  {(["web", "team_portal", "bulk"] as const).map((ch) => (
                    <Button
                      key={ch}
                      className="rounded-none"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(`Upload ${ch}`, () =>
                          post("/api/d1/ingestion/upload", {
                            text: fileText,
                            sourceChannel: ch,
                            classification: "confidential",
                            matterId: matters[0]?.id ?? null,
                          })
                        )
                      }
                    >
                      {ch}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Case number</CardTitle>
                <CardDescription>
                  Prefixes are data. Bare CP 1234 is rejected and opens an L17.8
                  follow-up. Court fee: MANUAL — do not compute.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  className="rounded-none"
                  value={rawNumber}
                  onChange={(e) => setRawNumber(e.target.value)}
                />
                <Button
                  className="rounded-none"
                  disabled={busy || !matters[0]}
                  onClick={() =>
                    run("Record number", () =>
                      post("/api/d6/court/recordCaseNumber", {
                        matterId: matters[0]?.id,
                        raw: rawNumber,
                        courtId: "SHC",
                      })
                    )
                  }
                >
                  Record on first matter
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="parties" className="mt-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Party / CNIC</CardTitle>
                <CardDescription>
                  Same 13-digit CNIC, two phones → confirmed-candidate. A conflict
                  check is POSSIBLE_CANDIDATE_REVIEW, never CLEAR.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 md:max-w-lg">
                <Input
                  className="rounded-none"
                  value={cnicName}
                  onChange={(e) => setCnicName(e.target.value)}
                />
                <Input
                  className="rounded-none"
                  value={cnic}
                  onChange={(e) => setCnic(e.target.value)}
                />
                <Input
                  className="rounded-none"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Button
                  className="rounded-none"
                  disabled={busy}
                  onClick={() =>
                    run("Create party", () =>
                      post("/api/d1/client/create", {
                        canonicalName: cnicName,
                        cnic,
                        phone,
                      })
                    )
                  }
                >
                  Add party
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channel" className="mt-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>WhatsApp grammar</CardTitle>
                <CardDescription>
                  Eight commands. Client cannot /research. Switch “Acting as” to
                  Client and send /matters then /research.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 md:max-w-lg">
                <Input
                  className="rounded-none"
                  value={wa}
                  onChange={(e) => setWa(e.target.value)}
                />
                <Button
                  className="rounded-none"
                  disabled={busy}
                  onClick={() =>
                    run("WhatsApp", () =>
                      post("/api/d2/whatsapp/command", { userId, command: wa })
                    )
                  }
                >
                  Send
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="gates" className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Citation + temporal</CardTitle>
                <CardDescription>
                  Overruled-by-larger-bench blocks. PPC 302 as at 2015 is not the
                  2018 amendment.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  className="rounded-none"
                  disabled={busy}
                  onClick={() =>
                    run("Run gates", () => post("/api/d4/intelligence/gate", {}))
                  }
                >
                  Run citation and temporal gates
                </Button>
              </CardContent>
            </Card>
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>P1 translation</CardTitle>
                <CardDescription>
                  Masked body only. Privileged is blocked until the firm records a
                  DPA. Classification stays in metadata.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  className="border-input min-h-20 w-full rounded-none border p-2 text-sm"
                  value={translateText}
                  onChange={(e) => setTranslateText(e.target.value)}
                />
                <select
                  className="border-input h-9 w-full rounded-none border bg-transparent px-2 text-sm"
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                >
                  <option value="internal">internal</option>
                  <option value="confidential">confidential</option>
                  <option value="privileged">privileged</option>
                </select>
                <Button
                  className="rounded-none"
                  disabled={busy}
                  onClick={() =>
                    run("Translate", () =>
                      post("/api/platform/brain/translate", {
                        text: translateText,
                        classification,
                      })
                    )
                  }
                >
                  Request translation
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle>Last result</CardTitle>
            <CardDescription>
              Empty until you take an action. Errors appear above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {log ? (
              <pre className="overflow-auto text-xs whitespace-pre-wrap">{log}</pre>
            ) : (
              <p className="text-muted-foreground text-sm">No action yet.</p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
