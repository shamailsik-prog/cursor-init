import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * PR #120 review (Codex, P1): every log-based alert policy filtered on `resource.type="cloud_function"`, the resource
 * type of first-generation Cloud Functions. Every function here is second generation (`firebase-functions/v2`), whose
 * runtime logs are written under `resource.type="cloud_run_revision"`, so no policy could ever match, and the F43
 * notifier's `ops_alert.notified` line (and every F32 ERROR policy) would reach no one.
 *
 * The test derives the resource types the filters must name from the runtime generation of the deployed exports (each
 * export's `__endpoint.platform`): any function may emit any registered line (the emitting modules, `log.ts` among them,
 * are shared by every function), so a filter must cover the generation of every export. It checks both what the
 * generator (`infra/render_terraform.py`) renders now and the committed `infra/terraform/alerts.tf`.
 */

/** The Cloud Logging resource type each Cloud Functions generation writes its runtime logs under. */
const RESOURCE_TYPE_BY_PLATFORM: Readonly<Record<string, string>> = { gcfv1: "cloud_function", gcfv2: "cloud_run_revision" }
const ROOT = path.resolve(__dirname, "../..")
const LAYER_FLAGS = ["CORE_ENABLED", "LEGACY_GOVERNANCE_CHAINS", "L17_2_ENABLED"]

type Manifest = { alerts: { policies: Array<{ event: string; surface: string }> } }

/** The `filter = '...'` strings of an alerts.tf text, in order. */
function filtersOf(alertsTf: string): string[] {
  return [...alertsTf.matchAll(/filter\s*=\s*'([^']*)'/g)].map((m) => m[1])
}

/** The resource types a filter names, sorted. */
function resourceTypesOf(filter: string): string[] {
  return [...filter.matchAll(/resource\.type="([a-z_]+)"/g)].map((m) => m[1]).sort()
}

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

describe("PR #120 review: log-based alert filters match the runtime generation of the functions that emit the lines", () => {
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

  it("every condition, rendered now and committed, filters on exactly the resource types of the exports' generations", async () => {
    vi.resetModules()
    const index = (await import("../src/index")) as unknown as Record<string, { __endpoint?: { platform?: string } }>
    const platforms = [...new Set(Object.values(index).map((fn) => fn.__endpoint?.platform ?? "unknown"))].sort()
    for (const p of platforms) expect([p, Object.hasOwn(RESOURCE_TYPE_BY_PLATFORM, p)]).toEqual([p, true])
    const expected = [...new Set(platforms.map((p) => RESOURCE_TYPE_BY_PLATFORM[p]))].sort()
    // Ruling recorded in the spec: every export is second generation today, so the filters name cloud_run_revision alone.
    expect(expected).toEqual(["cloud_run_revision"])

    const manifest = JSON.parse(readFileSync(path.join(ROOT, "infra/deploy-manifest.json"), "utf8")) as Manifest
    const events = manifest.alerts.policies.filter((p) => p.surface === "functions").map((p) => p.event)
    const committed = readFileSync(path.join(ROOT, "infra/terraform/alerts.tf"), "utf8")
    for (const [label, tf] of [["rendered", renderedAlertsTf()], ["committed", committed]] as const) {
      const filters = filtersOf(tf)
      expect([label, filters.length]).toEqual([label, events.length])
      for (const [i, filter] of filters.entries()) {
        expect([label, events[i], resourceTypesOf(filter)]).toEqual([label, events[i], expected])
        expect([label, filter.includes(`jsonPayload.message="${events[i]}"`), filter.includes('severity="ERROR"')]).toEqual([label, true, true])
      }
    }
  })
})
