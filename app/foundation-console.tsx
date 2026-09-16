"use client"

import { useMemo, useState } from "react"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { CourtRecord, NormaliseResult } from "@/core/case-number-normaliser"
import type { DocumentType } from "@/lib/foundation-data"
import { SystemMonitor } from "@/app/system-monitor"
import {
  CLASSIFICATION_RANKS,
  FEATURE_FLAGS,
  FIRESTORE_COLLECTIONS,
  G0_GUARDS,
  OPEN_ITEMS,
} from "@/lib/foundation-data"

type Props = {
  courts: CourtRecord[]
  fixtures: [string, string, string | null, boolean][]
  types: DocumentType[]
}

const TABS = [
  { value: "monitor", label: "Monitor" },
  { value: "gate", label: "Gate G-0" },
  { value: "courts", label: "Courts" },
  { value: "types", label: "159 types" },
  { value: "flags", label: "Flags" },
  { value: "open", label: "Open items" },
] as const

export function FoundationConsole({ courts, fixtures, types }: Props) {
  const [tab, setTab] = useState("monitor")
  const [courtId, setCourtId] = useState(courts[0]?.id ?? "SHC")
  const [raw, setRaw] = useState("C.P. No. D-1234 of 2025")
  const [result, setResult] = useState<NormaliseResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [selectedId, setSelectedId] = useState(types[0]?.id ?? "")

  const categories = useMemo(() => {
    return Array.from(new Set(types.map((t) => t.category))).sort()
  }, [types])

  const filteredTypes = useMemo(() => {
    const q = query.trim().toLowerCase()
    return types.filter((t) => {
      if (category !== "all" && t.category !== category) return false
      if (!q) return true
      return (
        t.id.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.posture.toLowerCase().includes(q)
      )
    })
  }, [types, query, category])

  const selectedType =
    filteredTypes.find((t) => t.id === selectedId) ?? filteredTypes[0]

  async function runNormalise() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/g0/normalise", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ raw, courtId }),
      })
      const json = (await res.json()) as {
        result?: NormaliseResult
        error?: string
      }
      if (!res.ok) {
        setResult(null)
        setError(json.error ?? "Normaliser request failed.")
        return
      }
      setResult(json.result ?? null)
    } catch {
      setResult(null)
      setError("Could not reach the Phase 0 normaliser.")
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
              NHS Legal · Karachi · Phase 0
            </p>
            <h1 className="font-heading mt-2 text-3xl tracking-tight md:text-4xl">
              SIKANDER AI
            </h1>
            <p className="mt-2 max-w-xl text-sm text-[color:var(--paper)]/75">
              Litigation operating system — foundations only. Gate G-0 and the
              G-1 spine are green. Layer 3–16 work has not started.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge className="rounded-none border-[color:var(--brass)] bg-transparent text-[color:var(--brass)]">
              G-0 PASSED
            </Badge>
            <Badge variant="secondary" className="rounded-none">
              v10.1.1 + L18 + Erratum 1
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList
            variant="line"
            className="h-auto w-full flex-wrap justify-start gap-0 rounded-none bg-transparent p-0"
          >
            {TABS.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                className="rounded-none border-b-2 border-transparent px-3 py-2 data-active:border-[color:var(--ink)] data-active:bg-transparent"
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="monitor" className="mt-4">
            <SystemMonitor />
          </TabsContent>

          <TabsContent value="gate" className="mt-4">
            <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <Card className="rounded-none ring-[color:var(--ink)]/10">
                <CardHeader>
                  <CardTitle>G-0 static guards</CardTitle>
                  <CardDescription>
                    `bash ci_gates/gate_g0.sh` — every check fails the build. No
                    warn-only checks. Fee, scraper, provider, master-write,
                    idempotency, pagination, classification, embedding lock.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {G0_GUARDS.map((g) => (
                    <div
                      key={g.id}
                      className="flex gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                    >
                      <span className="font-heading w-8 text-[color:var(--brass-ink)]">
                        {String(g.id).padStart(2, "0")}
                      </span>
                      <div>
                        <p className="font-medium">{g.name}</p>
                        <p className="text-muted-foreground text-xs">{g.detail}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <div className="space-y-4">
                <Card className="rounded-none">
                  <CardHeader>
                    <CardTitle>Non-negotiables</CardTitle>
                    <CardDescription>CI enforces these. Do not invent around them.</CardDescription>
                  </CardHeader>
                  <CardContent className="text-muted-foreground space-y-2 text-sm">
                    <p>Court fee: MANUAL — do not compute</p>
                    <p>Stamp duty: MANUAL — do not compute</p>
                    <p>L17.9 REMOVED by E-15 (8 Sep 2026)</p>
                    <p>Every AI / OCR / STT / TTS / translation call goes through P1 with a classification.</p>
                    <p>No scraper in this repository. Corpus service is a separate tree.</p>
                    <p>Tenant and matter scoping at the data layer. No role exempt.</p>
                    <p>Master knowledge is written by P6 only.</p>
                    <p>Citation gate + human approval before any court-facing document leaves.</p>
                    <p>Loose vault never deletes; escalate at 30 days.</p>
                  </CardContent>
                </Card>
                <Card className="rounded-none">
                  <CardHeader>
                    <CardTitle>Classification ranks</CardTitle>
                    <CardDescription>Monotonic. Downgrade only via partner declassify().</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {CLASSIFICATION_RANKS.map((c) => (
                      <Badge key={c.label} variant="outline" className="rounded-none">
                        {c.rank} {c.label}
                      </Badge>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="courts" className="mt-4 space-y-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Prefix table</CardTitle>
                <CardDescription>
                  Prefixes are data. Add a court or a prefix here, never in code.
                  O-9 is still open — confirm against NHS filings.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
                  <div className="space-y-3">
                    <label className="text-xs tracking-wide uppercase">Court</label>
                    <Select
                      value={courtId}
                      onValueChange={(value) => {
                        if (value) setCourtId(value)
                      }}
                    >
                      <SelectTrigger className="w-full rounded-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {courts.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.id} — {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <label className="text-xs tracking-wide uppercase">
                      Cause-list string
                    </label>
                    <Input
                      className="rounded-none"
                      value={raw}
                      onChange={(e) => setRaw(e.target.value)}
                      placeholder="C.P. No. D-1234 of 2025"
                    />
                    <Button
                      className="rounded-none"
                      onClick={runNormalise}
                      disabled={busy || !raw.trim()}
                    >
                      {busy ? "Normalising…" : "Normalise"}
                    </Button>
                    {error ? (
                      <p className="text-destructive text-sm">{error}</p>
                    ) : null}
                    {result ? <ResultCard result={result} /> : null}
                    {!result && !error && !busy ? (
                      <p className="text-muted-foreground text-sm">
                        Empty until you run a string. Rejected numbers open an
                        L17.8 follow-up — they are not rewritten.
                      </p>
                    ) : null}
                  </div>
                  <ScrollArea className="h-[420px] border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Court</TableHead>
                          <TableHead>Input</TableHead>
                          <TableHead>Expect</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {fixtures.map(([id, input, expected, shouldPass], i) => (
                          <TableRow key={`${id}-${i}`}>
                            <TableCell className="font-mono text-xs">{id}</TableCell>
                            <TableCell className="text-xs">{input}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {shouldPass ? expected : "REJECT"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="types" className="mt-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Document types — keyed on id</CardTitle>
                <CardDescription>
                  159 VERIFIED. Do not invent types. Search by id, name, or posture.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-2 md:flex-row">
                  <Input
                    className="rounded-none md:max-w-sm"
                    placeholder="Search id / name / posture"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <Select
                    value={category}
                    onValueChange={(value) => {
                      if (value) setCategory(value)
                    }}
                  >
                    <SelectTrigger className="w-full rounded-none md:w-56">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All categories</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground self-center text-sm">
                    {filteredTypes.length} shown
                  </p>
                </div>
                {filteredTypes.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No type matches that search. Types are not invented on the fly.
                  </p>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
                    <ScrollArea className="h-[480px] border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>id</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Posture</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredTypes.map((t) => (
                            <TableRow
                              key={t.id}
                              className="cursor-pointer"
                              onClick={() => setSelectedId(t.id)}
                            >
                              <TableCell className="font-mono text-xs">{t.id}</TableCell>
                              <TableCell>{t.name}</TableCell>
                              <TableCell className="text-xs">{t.posture}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                    {selectedType ? (
                      <div className="space-y-3 text-sm">
                        <p className="font-heading text-lg">{selectedType.name}</p>
                        <p className="font-mono text-xs">{selectedType.id}</p>
                        <p>
                          <span className="text-muted-foreground">Temporal: </span>
                          {selectedType.temporalBindingRule}
                        </p>
                        <p className="text-muted-foreground">{selectedType.firstGroundRule}</p>
                        <Separator />
                        <p className="text-xs tracking-wide uppercase">Required fields</p>
                        <div className="flex flex-wrap gap-1">
                          {selectedType.requiredFields.map((f) => (
                            <Badge key={f} variant="outline" className="rounded-none">
                              {f}
                            </Badge>
                          ))}
                        </div>
                        <p className="text-xs tracking-wide uppercase">Checklist</p>
                        <ul className="text-muted-foreground list-disc space-y-1 pl-4">
                          {selectedType.checklist.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="flags" className="mt-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="rounded-none">
                <CardHeader>
                  <CardTitle>Feature flags</CardTitle>
                  <CardDescription>
                    Kill-switch per layer. L18_TEMPLATE_EXAMPLE is off — core still boots.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Flag</TableHead>
                        <TableHead>Default</TableHead>
                        <TableHead>Layer</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {FEATURE_FLAGS.map((f) => (
                        <TableRow key={f.flag}>
                          <TableCell className="font-mono text-xs">{f.flag}</TableCell>
                          <TableCell>
                            {f.defaultEnabled ? "on" : "off"}
                          </TableCell>
                          <TableCell>{f.layer}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card className="rounded-none">
                <CardHeader>
                  <CardTitle>Firestore collections</CardTitle>
                  <CardDescription>
                    Every collection has a rule. Default deny at the end.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {FIRESTORE_COLLECTIONS.map((c) => (
                    <Badge key={c} variant="outline" className="rounded-none font-mono">
                      {c}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="open" className="mt-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Firm-only open items</CardTitle>
                <CardDescription>
                  Erratum Set No. 1 §ES1-4. Values are not invented in this tree.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {OPEN_ITEMS.map((item) => (
                  <div key={item.id} className="border-b border-border pb-3 last:border-0">
                    <p className="font-medium">
                      {item.id} · {item.title}
                    </p>
                    <p className="text-muted-foreground text-sm">{item.note}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

function ResultCard({ result }: { result: NormaliseResult }) {
  if (result.status === "REJECT") {
    return (
      <div className="border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="font-medium text-destructive">REJECT</p>
        <p>{result.reason}</p>
      </div>
    )
  }
  return (
    <div className="border border-[color:var(--ink)]/20 bg-[color:var(--paper-2)] p-3 text-sm">
      <p className="font-medium">
        {result.status} · {result.canonical}
      </p>
      {result.flags.includes("AMBIGUOUS") ? (
        <p className="text-muted-foreground mt-1 text-xs">{result.note}</p>
      ) : null}
    </div>
  )
}
