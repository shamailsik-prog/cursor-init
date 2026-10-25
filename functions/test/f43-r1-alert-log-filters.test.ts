import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { format } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "firebase-functions"
import { logAlertNotifier } from "../src/alerts/notifier"
import { logRegisteredError } from "../src/log"

/**
 * FA-F43-R1-001: log-based alert policies must match real Cloud Logging output. `firebase-functions` 6.6+ turns
 * `logger.error("event", fields)` into a stack trace on `jsonPayload.message`, so filters on `message=` never fire.
 * Policies filter on `jsonPayload.event`; emitters use `logRegisteredError` (`logger.write`).
 */

const ROOT = path.resolve(__dirname, "../..")
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]

type Manifest = { alerts: { policies: Array<{ event: string; surface: string }> } }

/** Mimics `firebase-functions` `entryFromArgs` for ERROR (the behaviour under test). */
function legacyErrorPayload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  let message = format(event)
  message = new Error(message).stack || message
  return { severity: "ERROR", message, ...fields }
}

/** What `logger.write` emits for a registered line (parsed JSON line on stderr in production). */
function structuredErrorPayload(event: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, event, severity: "ERROR" }
}

/** Extract `filter = "..."` values from alerts.tf (double-quoted HCL). */
function filtersOf(alertsTf: string): string[] {
  return [...alertsTf.matchAll(/filter\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'))
}

function matchesLogFilter(filter: string, entry: Record<string, unknown>): boolean {
  if (filter.includes('severity="ERROR"') && entry.severity !== "ERROR") return false
  if (filter.includes('resource.type="cloud_run_revision"')) {
    // Runtime tests only check jsonPayload fields; resource.type is environment metadata.
  }
  const eventEq = filter.match(/jsonPayload\.event="([^"]+)"/)
  if (eventEq) return entry.event === eventEq[1]
  const messageEq = filter.match(/jsonPayload\.message="([^"]+)"/)
  if (messageEq) return entry.message === messageEq[1]
  return false
}

function renderedAlertsTf(): string {
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'infra')",
    "import render_terraform",
    "manifest = json.load(open('infra/deploy-manifest.json', encoding='utf-8'))",
    "sys.stdout.write(render_terraform.render(manifest)['alerts.tf'])",
  ].join("\n")
  const out = spawnSync("python3", ["-c", script], { cwd: ROOT, encoding: "utf8" })
  if (out.status !== 0) throw new Error(`render_terraform failed: ${out.stderr}`)
  return out.stdout
}

describe("FA-F43-R1-001: log-based alert filters match structured runtime logs", () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const f of LAYER_FLAGS) {
      saved[f] = process.env[`SIKANDER_FLAG_${f}`]
      process.env[`SIKANDER_FLAG_${f}`] = "false"
    }
  })
  afterEach(() => {
    for (const f of LAYER_FLAGS) {
      if (saved[f] === undefined) delete process.env[`SIKANDER_FLAG_${f}`]
      else process.env[`SIKANDER_FLAG_${f}`] = saved[f]
    }
    vi.resetModules()
  })

  it("legacy logger.error message equality does not match; structured event filters do", () => {
    const event = "ops_alert.notified"
    const fields = { pageId: "p1", alertId: "a1", firmId: "f1", condition: "job.dead_lettered", pageSeverity: "high", level: 0, ownerRole: "operator", episode: 1, users: 0, fallback: null }
    const legacy = legacyErrorPayload(event, fields)
    const structured = structuredErrorPayload(event, fields)
    expect(legacy.message).toContain("ops_alert.notified")
    expect(legacy.message).not.toBe(event)
    const filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.event="ops_alert.notified"'
    expect(matchesLogFilter(filter, legacy)).toBe(false)
    expect(matchesLogFilter(filter, structured)).toBe(true)
  })

  it("FA-F43-R2-001: logRegisteredError keeps Cloud Logging severity ERROR when fields carry domain severity", () => {
    const writeSpy = vi.spyOn(logger, "write").mockImplementation(() => undefined)
    logRegisteredError("ops_alert.notified", {
      pageId: "p1",
      alertId: "a1",
      firmId: "f1",
      condition: "job.dead_lettered",
      severity: "critical",
      level: 0,
      ownerRole: "operator",
      episode: 1,
      users: 0,
      fallback: null,
    })
    const emitted = writeSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(emitted.severity).toBe("ERROR")
    expect(emitted.event).toBe("ops_alert.notified")
    writeSpy.mockRestore()

    const lines: string[] = []
    const writeSpy2 = vi.spyOn(logger, "write").mockImplementation((entry) => {
      lines.push(JSON.stringify(entry))
    })
    return logAlertNotifier.deliver({
      id: "pg1",
      alertId: "al1",
      firmId: "fm1",
      condition: "job.dead_lettered",
      severity: "critical",
      level: 1,
      ownerRole: "partner",
      episode: 2,
      targets: [{ kind: "oncall" }],
      fallback: null,
      status: "pending",
      claimedUntil: null,
      deliveryAttempts: 0,
      createdAt: { toMillis: () => 0 } as never,
      deliveredAt: null,
    }).then(() => {
      writeSpy2.mockRestore()
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed).toMatchObject({ severity: "ERROR", event: "ops_alert.notified", pageSeverity: "critical" })
      const filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.event="ops_alert.notified"'
      expect(matchesLogFilter(filter, parsed)).toBe(true)
    })
  })

  it("logRegisteredError output matches every committed policy filter (one policy per event)", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "infra/deploy-manifest.json"), "utf8")) as Manifest
    const events = manifest.alerts.policies.filter((p) => p.surface === "functions").map((p) => p.event)
    const committed = readFileSync(path.join(ROOT, "infra/terraform/alerts.tf"), "utf8")
    const rendered = renderedAlertsTf()
    expect(rendered).toBe(committed)
    expect(committed.match(/resource "google_monitoring_alert_policy"/g)?.length).toBe(events.length)
    for (const tf of [rendered, committed]) {
      expect(tf).not.toMatch(/filter\s*=\s*'/)
      expect(tf).toMatch(/notification_rate_limit/)
    }
    const filters = filtersOf(committed)
    expect(filters.length).toBe(events.length)
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      const payload = structuredErrorPayload(event, { code: "sample" })
      expect([event, matchesLogFilter(filters[i], payload)]).toEqual([event, true])
      const lines: string[] = []
      const writeSpy = vi.spyOn(logger, "write").mockImplementation((entry) => {
        lines.push(JSON.stringify(entry))
      })
      logRegisteredError(event, { code: "sample" })
      writeSpy.mockRestore()
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>
      expect(matchesLogFilter(filters[i], parsed)).toBe(true)
    }
  })
})
