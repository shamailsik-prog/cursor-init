import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { logger } from "firebase-functions"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  attr,
  blocksOf,
  captureLoggerLines,
  errorEmitters,
  firebaseFunctionsVersion,
  logEntryOf,
  matches,
  parseHcl,
  str,
  type CapturedLine,
  type HclBlock,
  type HclBody,
} from "./alertPolicyTools"

/**
 * Audit F43 R1 (re-audit of #120 at 55cc8a4, FA-F43-R1-001, HIGH): the operator's page could never be delivered.
 *
 * (a) firebase-functions 6.6.0 writes an ERROR line's message as a stack trace (`message = "Error: <event>\n    at …"`),
 *     so the filter `jsonPayload.message="<event>"` (equality) matched no line, F32's included;
 * (b) every filter was a single-quoted HCL string, which Terraform refuses;
 * (c) one policy held 24 `condition_matched_log` conditions, and a log-match condition must be a policy's only one;
 * (d) no policy had `alert_strategy.notification_rate_limit`, required for a log-match policy.
 *
 * The correction (spec R15 to R17): every registered ERROR line carries `event: "<name>"` as its last structured field;
 * the renderer emits one double-quoted, rate-limited policy per event filtering `jsonPayload.event="<name>"`. This file
 * proves in the repo what can be proved without a `terraform` binary: the rendered and committed `alerts.tf` parse as
 * the HCL subset the renderer emits and have the required structure; each filter, evaluated with the Logging query
 * language's `=` semantics, matches the real logger's line for its own event and no other; real emitters' lines match;
 * and every emitter of a registered event carries the field (a walk of the TypeScript AST of `functions/src`).
 * `terraform validate` and delivery to a real inbox are NOT DEMONSTRATED.
 *
 * Kept from PR #120's review (Codex P1): the filters name the resource type of the exports' runtime generation.
 */

/** The Cloud Logging resource type each Cloud Functions generation writes its runtime logs under. */
const RESOURCE_TYPE_BY_PLATFORM: Readonly<Record<string, string>> = { gcfv1: "cloud_function", gcfv2: "cloud_run_revision" }
const ROOT = path.resolve(__dirname, "../..")
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]
const RUNTIME = "cloud_run_revision"

type Policy = { event: string; surface: string; files: string[]; runbook: string; labels?: Record<string, string> }
type Manifest = { alerts: { policies: Policy[] } }

const manifest = (): Manifest => JSON.parse(readFileSync(path.join(ROOT, "infra/deploy-manifest.json"), "utf8")) as Manifest
const functionsPolicies = () => manifest().alerts.policies.filter((p) => p.surface === "functions")

/** alerts.tf as the generator renders it from the manifest now (not the committed copy). */
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
const committedAlertsTf = () => readFileSync(path.join(ROOT, "infra/terraform/alerts.tf"), "utf8")

/** The alert policies of a parsed alerts.tf, keyed by the event their one condition names (its display_name). */
function policiesOf(body: HclBody): Array<{ name: string; block: HclBlock }> {
  return blocksOf(body, "resource")
    .filter((b) => b.labels[0] === "google_monitoring_alert_policy")
    .map((block) => ({ name: block.labels[1], block }))
}

/** The one filter of a policy (its single condition's `condition_matched_log.filter`). */
function filterOf(block: HclBlock): string {
  const [cond] = blocksOf(block.body, "conditions")
  const [log] = blocksOf(cond.body, "condition_matched_log")
  const filter = str(attr(log.body, "filter"))
  if (filter === undefined) throw new Error(`${block.labels[1]}: no filter string`)
  return filter
}

/** The policy whose single condition's display name is `event`. */
function policyFor(body: HclBody, event: string): HclBlock {
  const found = policiesOf(body).filter(({ block }) => str(attr(blocksOf(block.body, "conditions")[0]?.body ?? { attributes: new Map(), blocks: [] }, "display_name")) === event)
  if (found.length !== 1) throw new Error(`${found.length} policies for ${event}`)
  return found[0].block
}

/** The resource types a filter names, sorted. */
function resourceTypesOf(filter: string): string[] {
  return [...filter.matchAll(/resource\.type="([a-z_]+)"/g)].map((m) => m[1]).sort()
}

const linesOf = (captured: CapturedLine[], method: string) => captured.filter((c) => c.method === method).map((c) => c.line)

describe("FA-F43-R1-001: each log-based alert policy is valid and matches the real logger's line for its event", () => {
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
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  let rendered: string
  beforeAll(() => {
    rendered = renderedAlertsTf()
  })

  it("the committed alerts.tf is the generator's output, and both parse as HCL with double-quoted strings only", () => {
    expect(committedAlertsTf()).toBe(rendered)
    for (const [label, tf] of [["rendered", rendered], ["committed", committedAlertsTf()]] as const) {
      let error: string | null = null
      try {
        parseHcl(tf)
      } catch (err) {
        error = (err as Error).message
      }
      expect([label, error]).toEqual([label, null])
    }
  })

  it("one alert policy per registered event: exactly one log-match condition, a 300 s rate limit, auto-close and the on-call channel", () => {
    const body = parseHcl(rendered)
    const events = functionsPolicies().map((p) => p.event)
    const policies = policiesOf(body)
    expect(policies).toHaveLength(events.length)
    expect(new Set(policies.map((p) => p.name)).size).toBe(events.length)
    const channels = blocksOf(body, "resource").filter((b) => b.labels[0] === "google_monitoring_notification_channel")
    expect(channels.map((c) => [c.labels[1], str(attr(c.body, "type"))])).toEqual([["oncall", "email"]])

    for (const p of functionsPolicies()) {
      const block = policyFor(body, p.event)
      const conditions = blocksOf(block.body, "conditions")
      expect([p.event, conditions.length]).toEqual([p.event, 1])
      const cond = conditions[0].body
      expect([p.event, cond.blocks.map((b) => b.type)]).toEqual([p.event, ["condition_matched_log"]])
      const log = blocksOf(cond, "condition_matched_log")[0].body
      expect([p.event, typeof str(attr(log, "filter"))]).toEqual([p.event, "string"])
      expect([p.event, str(attr(block.body, "combiner")), typeof str(attr(block.body, "display_name"))]).toEqual([p.event, "OR", "string"])

      const strategy = blocksOf(block.body, "alert_strategy")
      expect([p.event, strategy.length]).toEqual([p.event, 1])
      const limit = blocksOf(strategy[0].body, "notification_rate_limit")
      expect([p.event, limit.map((l) => str(attr(l.body, "period")))]).toEqual([p.event, ["300s"]])
      expect([p.event, str(attr(strategy[0].body, "auto_close"))]).toEqual([p.event, "1800s"])

      const ch = attr(block.body, "notification_channels")
      expect([p.event, ch?.kind === "list" ? ch.items.map((i) => (i.kind === "ref" ? i.path.join(".") : i.kind)) : ch?.kind]).toEqual([
        p.event,
        ["google_monitoring_notification_channel.oncall.name"],
      ])
      const doc = blocksOf(block.body, "documentation")
      expect([p.event, doc.map((d) => str(attr(d.body, "content")))]).toEqual([p.event, [`Runbook: ${p.runbook}`]])
    }
  })

  it("every filter names exactly the resource types of the exports' runtime generations (PR #120 review)", async () => {
    vi.resetModules()
    const index = (await import("../src/index")) as unknown as Record<string, { __endpoint?: { platform?: string } }>
    const platforms = [...new Set(Object.values(index).map((fn) => fn.__endpoint?.platform ?? "unknown"))].sort()
    for (const p of platforms) expect([p, Object.hasOwn(RESOURCE_TYPE_BY_PLATFORM, p)]).toEqual([p, true])
    const expected = [...new Set(platforms.map((p) => RESOURCE_TYPE_BY_PLATFORM[p]))].sort()
    // Ruling recorded in the spec (R11a): every export is second generation, so the filters name cloud_run_revision alone.
    expect(expected).toEqual([RUNTIME])
    for (const { block, name } of policiesOf(parseHcl(rendered))) expect([name, resourceTypesOf(filterOf(block))]).toEqual([name, expected])
  })

  it("each filter matches firebase-functions' real ERROR line for its own event and no other line", async () => {
    expect(firebaseFunctionsVersion()).toBe("6.6.0")
    const body = parseHcl(rendered)
    const events = functionsPolicies().map((p) => p.event)
    // `=` ignores case (NFKC_CF): no two registered names may fold to the same value.
    expect(new Set(events.map((e) => e.normalize("NFKC").toLowerCase())).size).toBe(events.length)

    const own = new Map<string, string>()
    const warnTwin = new Map<string, string>()
    const withoutField = new Map<string, string>()
    for (const event of events) {
      const lines = await captureLoggerLines(() => {
        logger.error(event, { firmId: "firm-f43", code: "probe", event })
        logger.warn(event, { firmId: "firm-f43", event })
        logger.error(event, { firmId: "firm-f43", code: "probe" })
      })
      const errors = linesOf(lines, "error")
      expect([event, errors.length, linesOf(lines, "warn").length]).toEqual([event, 2, 1])
      own.set(event, errors[0])
      warnTwin.set(event, linesOf(lines, "warn")[0])
      withoutField.set(event, errors[1])
    }

    for (const event of events) {
      const entry = logEntryOf(own.get(event)!, RUNTIME)
      // The defect the audit found: the real ERROR message is a stack trace, so message equality never held.
      expect([event, String(entry.jsonPayload?.message).startsWith(`Error: ${event}\n`)]).toEqual([event, true])
      expect([event, matches(`jsonPayload.message="${event}"`, entry)]).toEqual([event, false])

      const filter = filterOf(policyFor(body, event))
      const hits = events.filter((other) => matches(filter, logEntryOf(own.get(other)!, RUNTIME)))
      expect([event, hits]).toEqual([event, [event]])
      expect([event, matches(filter, logEntryOf(warnTwin.get(event)!, RUNTIME))]).toEqual([event, false])
      expect([event, matches(filter, logEntryOf(withoutField.get(event)!, RUNTIME))]).toEqual([event, false])
      // Written by a first-generation function, the line would not match either (the resource clause holds).
      expect([event, matches(filter, logEntryOf(own.get(event)!, "cloud_function"))]).toEqual([event, false])
    }
  })

  it("real emitters: the notifier's page, the dead-letter line and the deploy-contract refusal each match their own policy and no other", async () => {
    const body = parseHcl(rendered)
    const events = functionsPolicies().map((p) => p.event)
    const hitsOf = (line: string) => events.filter((e) => matches(filterOf(policyFor(body, e)), logEntryOf(line, RUNTIME)))

    const { logAlertNotifier } = await import("../src/alerts/notifier")
    const page = await captureLoggerLines(() =>
      logAlertNotifier.deliver({
        id: "a0123456789abcdef0123456789abcdef01234567_e1_l0",
        alertId: "a0123456789abcdef0123456789abcdef01234567",
        firmId: "firm-f43",
        condition: "job.dead_lettered",
        severity: "high",
        level: 0,
        ownerRole: "operator",
        episode: 1,
        targets: [{ kind: "oncall" }],
        fallback: null,
        status: "sending",
        claimedUntil: null,
        deliveryAttempts: 1,
        createdAt: null as never,
        deliveredAt: null,
      })
    )
    expect(page.map((l) => l.method)).toEqual(["error"])
    expect(hitsOf(page[0].line)).toEqual(["ops_alert.notified"])
    // The page policy extracts the page id, so the rate limit applies per page (spec R16a).
    const pagePolicy = policyFor(body, "ops_alert.notified")
    const extractors = attr(blocksOf(blocksOf(pagePolicy.body, "conditions")[0].body, "condition_matched_log")[0].body, "label_extractors")
    expect(extractors?.kind === "object" ? extractors.entries.map(([k, v]) => [k, str(v)]) : extractors).toEqual([["page_id", "EXTRACT(jsonPayload.pageId)"]])
    expect(logEntryOf(page[0].line, RUNTIME).jsonPayload?.pageId).toBe("a0123456789abcdef0123456789abcdef01234567_e1_l0")

    const { logDeadLetterAlert } = await import("../src/p2/jobEvents")
    const dead = await captureLoggerLines(() => logDeadLetterAlert.deadLettered({ jobId: "j1", jobType: "platform.diagnostic", firmId: "firm-f43", attempts: 4, code: "internal" }))
    expect(dead.map((l) => l.method)).toEqual(["error"])
    expect(hitsOf(dead[0].line)).toEqual(["job.deadLettered"])

    vi.resetModules()
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_INGRESS_SETTINGS", "ALLOW_ALL")
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    const refusal = await captureLoggerLines(async () => {
      await expect(import("../src/deployConfig")).rejects.toMatchObject({ name: "DeployContractError" })
    })
    expect(refusal.map((l) => l.method)).toEqual(["error"])
    expect(hitsOf(refusal[0].line)).toEqual(["deploy.contract_violation"])
  })

  it("registry walk: every ERROR emitter of a registered event carries the event as its last structured field, in a file the manifest lists", () => {
    const policies = functionsPolicies()
    const registered = new Map(policies.map((p) => [p.event, p]))
    const emitters = errorEmitters(path.join(ROOT, "functions/src"), ROOT)
    const where = (e: { file: string; line: number }) => `${e.file}:${e.line}`

    // Every registered event has at least one emitter the walk can see.
    expect(policies.filter((p) => !emitters.some((e) => e.event === p.event)).map((p) => p.event)).toEqual([])
    const ofRegistered = emitters.filter((e) => registered.has(e.event))
    expect(ofRegistered.length).toBeGreaterThanOrEqual(policies.length)
    // Each carries `event: "<its own event>"` as the data's last property (no spread after it can override it).
    expect(ofRegistered.filter((e) => e.dataEvent !== e.event || !e.eventIsLast).map((e) => `${where(e)} ${e.event} event=${e.dataEvent} last=${e.eventIsLast}`)).toEqual([])
    // Each sits in a file its policy lists (the manifest names every emitting module).
    expect(ofRegistered.filter((e) => !registered.get(e.event)!.files.includes(e.file)).map((e) => `${where(e)} ${e.event}`)).toEqual([])
    // No ERROR line anywhere names another event in its `event` field (it would page the wrong policy).
    expect(emitters.filter((e) => e.dataEvent !== null && e.dataEvent !== e.event).map((e) => `${where(e)} ${e.event} event=${e.dataEvent}`)).toEqual([])
  })
})
