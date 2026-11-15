import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  OBS_EXPORTER_ENABLED_VALUE,
  OBS_LOG_EXPORTER_FLAG,
  OBS_METRICS_EXPORTER_FLAG,
  OBS_TRACE_EXPORTER_FLAG,
  createLineSink,
  createObservability,
  type SignalSink,
} from "@/platform/observability"

/**
 * Q15a: every exporter is off unless its flag is exactly "enabled".
 * With no config, a log, a metric and a span stay inside the process.
 */

const FLAGS = [OBS_LOG_EXPORTER_FLAG, OBS_METRICS_EXPORTER_FLAG, OBS_TRACE_EXPORTER_FLAG] as const

const password = "hun" + "ter2"
const email = "person" + "@" + "example.com"

function sinks(): { log: SignalSink; metrics: SignalSink; trace: SignalSink; lines: { sink: string; record: unknown }[] } {
  const lines: { sink: string; record: unknown }[] = []
  const capture = (sink: string): SignalSink => (record) => {
    lines.push({ sink, record })
  }
  return { log: capture("log"), metrics: capture("metrics"), trace: capture("trace"), lines }
}

function exercise(obs: ReturnType<typeof createObservability>): void {
  obs.log("info", "job.done", { firmId: "firm_1", password, email })
  obs.counter("job.done", 1, { firmId: "firm_1", password })
  obs.histogram("job.duration_ms", 12, { email })
  const span = obs.startSpan("job.run", { firmId: "firm_1", documentText: "SECRET_PLEADING" })
  span.setAttribute("note", "MATTER_NOTE")
  span.recordException(new Error("password=" + password))
  span.end("ok")
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("Q15a exporter flags", () => {
  it("names one flag per signal and enables only the exact value", () => {
    expect(OBS_LOG_EXPORTER_FLAG).toBe("LEGAL_OS_OBS_LOG_EXPORTER")
    expect(OBS_METRICS_EXPORTER_FLAG).toBe("LEGAL_OS_OBS_METRICS_EXPORTER")
    expect(OBS_TRACE_EXPORTER_FLAG).toBe("LEGAL_OS_OBS_TRACE_EXPORTER")
    expect(OBS_EXPORTER_ENABLED_VALUE).toBe("enabled")
  })

  it("with no config, nothing leaves the process", () => {
    const env = { ...process.env }
    for (const flag of FLAGS) delete env[flag]
    const stdout: string[] = []
    const stderr: string[] = []
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    vi.spyOn(process.stdout, "write").mockImplementation((chunk, encoding, cb) => {
      stdout.push(String(chunk))
      return stdoutWrite(chunk, encoding as never, cb as never)
    })
    vi.spyOn(process.stderr, "write").mockImplementation((chunk, encoding, cb) => {
      stderr.push(String(chunk))
      return stderrWrite(chunk, encoding as never, cb as never)
    })
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    let fetches = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetches += 1
      return originalFetch(...args)
    }) as typeof fetch

    const captured = sinks()
    try {
      exercise(createObservability({ env, logSink: captured.log, metricsSink: captured.metrics, traceSink: captured.trace }))
      exercise(createObservability({ env }))
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(captured.lines).toEqual([])
    const leaked = [...stdout, ...stderr].join("\n")
    expect(leaked).not.toContain(password)
    expect(leaked).not.toContain(email)
    expect(leaked).not.toContain("SECRET_PLEADING")
    expect(leaked).not.toContain("job.done")
    expect(fetches).toBe(0)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("treats true, 1, on, yes and ENABLED as off", () => {
    for (const value of ["true", "1", "on", "yes", "ENABLED", "enable", ""]) {
      const captured = sinks()
      const env = Object.fromEntries(FLAGS.map((flag) => [flag, value]))
      exercise(
        createObservability({
          env,
          logSink: captured.log,
          metricsSink: captured.metrics,
          traceSink: captured.trace,
        }),
      )
      expect(captured.lines).toEqual([])
    }
  })

  it("calls only the sink whose flag is exactly enabled, with redacted fields", () => {
    const captured = sinks()
    exercise(
      createObservability({
        env: { [OBS_LOG_EXPORTER_FLAG]: " enabled " },
        logSink: captured.log,
        metricsSink: captured.metrics,
        traceSink: captured.trace,
      }),
    )
    expect(captured.lines.map((line) => line.sink)).toEqual(["log"])
    const record = captured.lines[0]?.record as Record<string, unknown>
    expect(record).toMatchObject({ signal: "log", level: "info", event: "job.done", firmId: "firm_1" })
    expect(JSON.stringify(record)).not.toContain(password)
    expect(JSON.stringify(record)).not.toContain(email)

    const metrics = sinks()
    exercise(
      createObservability({
        env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
        logSink: metrics.log,
        metricsSink: metrics.metrics,
        traceSink: metrics.trace,
      }),
    )
    expect(metrics.lines.every((line) => line.sink === "metrics")).toBe(true)
    expect(metrics.lines.length).toBe(2)
    expect(JSON.stringify(metrics.lines)).not.toContain(password)
    expect(JSON.stringify(metrics.lines)).not.toContain(email)

    const traces = sinks()
    exercise(
      createObservability({
        env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
        logSink: traces.log,
        metricsSink: traces.metrics,
        traceSink: traces.trace,
      }),
    )
    expect(traces.lines).toHaveLength(1)
    expect(traces.lines[0]?.sink).toBe("trace")
    const span = traces.lines[0]?.record as Record<string, unknown>
    expect(span).toMatchObject({ signal: "trace", event: "job.run", firmId: "firm_1", status: "ok" })
    expect(typeof span.traceId).toBe("string")
    expect(typeof span.spanId).toBe("string")
    expect(JSON.stringify(span)).not.toContain(password)
    expect(JSON.stringify(span)).not.toContain("SECRET_PLEADING")
    expect(JSON.stringify(span)).not.toContain("MATTER_NOTE")
  })

  it("does not export an identifier-length number as a metric value", () => {
    const digits = "35202" + "1234567" + "1"
    const captured = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: captured.metrics,
    }).counter("job.done", Number(digits), { firmId: "firm_1" })
    expect(captured.lines).toHaveLength(1)
    expect(JSON.stringify(captured.lines[0]?.record)).not.toContain(digits)
    expect(captured.lines[0]?.record).toMatchObject({ metric: "job.done", firmId: "firm_1" })
  })

  it("writes a line sink only when the matching flag is enabled", () => {
    const lines: string[] = []
    const sink = createLineSink((line) => lines.push(line))
    exercise(createObservability({ env: {}, logSink: sink }))
    expect(lines).toEqual([])
    exercise(createObservability({ env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" }, logSink: sink }))
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>
    expect(parsed.event).toBe("job.done")
    expect(lines[0]).not.toContain(password)
    expect(lines[0]).not.toContain(email)
  })

  it("has no network exporter in the observability sources", () => {
    const dir = path.resolve(__dirname, "../platform/observability")
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const source = readFileSync(path.join(dir, name), "utf8")
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/https?:\/\//)
      expect(source).not.toMatch(/\baxios\b/)
    }
  })
})
