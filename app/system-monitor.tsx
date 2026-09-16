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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  formatDuration,
  type ProcessingState,
  type SystemStatus,
} from "@/lib/system-status"

const STATE_LABEL: Record<ProcessingState, string> = {
  running: "processing",
  waiting: "waiting",
  idle: "idle",
  blocked: "blocked",
  none: "none",
}

function stateVariant(state: ProcessingState) {
  if (state === "running") return "default" as const
  if (state === "waiting") return "secondary" as const
  if (state === "blocked") return "destructive" as const
  return "outline" as const
}

export function SystemMonitor() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/g0/monitor?limit=1&cursor=0")
      const json = (await res.json()) as {
        status?: SystemStatus
        error?: string
      }
      if (!res.ok || !json.status) {
        setStatus(null)
        setError(json.error ?? "Monitor request failed.")
        return
      }
      setStatus(json.status)
    } catch {
      setStatus(null)
      setError("Could not reach the monitor.")
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-4">
      <Card className="rounded-none">
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>What is happening</CardTitle>
            <CardDescription>
              Press Update after any change. This is the Phase 0 monitor — not
              the L4 Command Dashboard.
            </CardDescription>
          </div>
          <Button
            className="rounded-none"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "Updating…" : "Update"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          {!status && !error && busy ? (
            <p className="text-muted-foreground text-sm">
              Reading the system…
            </p>
          ) : null}
          {status ? (
            <>
              <p className="font-heading text-lg">{status.processingNow}</p>
              <p className="text-muted-foreground text-sm">
                {status.location.where}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge className="rounded-none" variant="outline">
                  {status.location.phase}
                </Badge>
                <Badge className="rounded-none" variant="outline">
                  G-0 {status.location.gateG0}
                </Badge>
                <Badge className="rounded-none" variant="outline">
                  G-1 {status.location.gateG1}
                </Badge>
                <Badge className="rounded-none" variant="outline">
                  L3–16 {status.location.layers316}
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs">
                Last refresh {status.generatedAt} · this Update took{" "}
                {formatDuration(status.refreshElapsedMs)}
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {status ? (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card className="rounded-none">
            <CardHeader>
              <CardTitle>At the moment</CardTitle>
              <CardDescription>
                Live product work plus last-measured workspace runs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {status.processing.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing is processing.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Work</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {status.processing.map((item) => (
                      <TableRow key={item.name}>
                        <TableCell>
                          <p className="font-medium">{item.name}</p>
                          <p className="text-muted-foreground text-xs">
                            {item.detail}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={stateVariant(item.state)}
                            className="rounded-none"
                          >
                            {STATE_LABEL[item.state]}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {formatDuration(item.elapsedMs)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>How long it took</CardTitle>
                <CardDescription>
                  Last measured gate and test runs on this tree.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {status.timings.map((check) => (
                  <div
                    key={check.id}
                    className="flex items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="font-medium">{check.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {check.measuredAt}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm">
                        {formatDuration(check.elapsedMs)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {check.result}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="rounded-none">
              <CardHeader>
                <CardTitle>Where the system is</CardTitle>
                <CardDescription>
                  {status.location.product} · {status.location.firm}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-muted-foreground space-y-2 text-sm">
                <p>{status.inventory.documentTypes} document types (id-keyed)</p>
                <p>{status.inventory.courts} courts in the prefix table</p>
                <p>
                  {status.inventory.firestoreCollections} Firestore collections
                  with rules
                </p>
                <p>{status.inventory.g0Guards} G-0 static guards</p>
                <p>{status.inventory.openItems} firm-only open items</p>
                {status.backends.map((backend) => (
                  <p key={backend.name}>
                    {backend.name}: {backend.state.replaceAll("_", " ")} —{" "}
                    {backend.note}
                  </p>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  )
}
