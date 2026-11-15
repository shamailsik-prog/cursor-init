import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as observability from "@/platform/observability"
import {
  OBS_EXPORTER_ENABLED_VALUE,
  OBS_LOG_EXPORTER_FLAG,
  OBS_METRICS_EXPORTER_FLAG,
  OBS_TRACE_EXPORTER_FLAG,
  REDACTED,
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
  obs.log("info", "job_done", { firmId: "firm_1", password, email })
  obs.counter("job_done", 1, { firmId: "firm_1", password })
  obs.histogram("job_duration_ms", 12, { email })
  const span = obs.startSpan("job_run", { firmId: "firm_1", documentText: "SECRET_PLEADING" })
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
    expect(leaked).not.toContain("job_done")
    expect(fetches).toBe(0)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("treats true, 1, on, yes, ENABLED and padded values as off", () => {
    const nbsp = "\u00A0"
    for (const value of ["true", "1", "on", "yes", "ENABLED", "enable", "", " enabled", "enabled\n", " enabled ", nbsp + "enabled", "enabled" + nbsp, nbsp + "enabled" + nbsp]) {
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
        env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
        logSink: captured.log,
        metricsSink: captured.metrics,
        traceSink: captured.trace,
      }),
    )
    expect(captured.lines.map((line) => line.sink)).toEqual(["log"])
    const record = captured.lines[0]?.record as Record<string, unknown>
    expect(record).toMatchObject({ signal: "log", level: "info", event: "job_done", firmId: "firm_1" })
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
    expect(span).toMatchObject({ signal: "trace", event: "job_run", firmId: "firm_1", status: "ok" })
    expect(typeof span.traceId).toBe("string")
    expect(typeof span.spanId).toBe("string")
    expect(JSON.stringify(span)).not.toContain(password)
    expect(JSON.stringify(span)).not.toContain("SECRET_PLEADING")
    expect(JSON.stringify(span)).not.toContain("MATTER_NOTE")
  })

  it("replaces an unsafe event name and does not emit a span twice", () => {
    const captured = sinks()
    const obs = createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled", [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      logSink: captured.log,
      traceSink: captured.trace,
    })
    obs.log("INFO" as "info", "Job Done", { firmId: "firm_1" })
    expect(captured.lines[0]?.record).toMatchObject({ level: "error", event: "invalid", firmId: "firm_1" })
    const span = obs.startSpan("job_run", { firmId: "firm_1" })
    span.end("ok")
    span.end("error")
    const traces = captured.lines.filter((line) => line.sink === "trace")
    expect(traces).toHaveLength(1)
    expect(traces[0]?.record).toMatchObject({ status: "ok" })
  })

  it("does not walk a nested value on an allowlisted field", () => {
    let reads = 0
    const child: Record<string, unknown> = {}
    Object.defineProperty(child, "email", {
      enumerable: true,
      get() {
        reads += 1
        throw new Error("nested")
      },
    })
    const captured = sinks()
    expect(() =>
      createObservability({
        env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
        logSink: captured.log,
      }).log("info", "job_done", { firmId: "firm_1", code: child }),
    ).not.toThrow()
    expect(reads).toBe(0)
    expect(captured.lines[0]?.record).toMatchObject({ firmId: "firm_1", code: REDACTED })
  })

  it("does not export an identifier-length number as a metric value", () => {
    const digits = "35202" + "1234567" + "1"
    const captured = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: captured.metrics,
    }).counter("job_done", Number(digits), { firmId: "firm_1" })
    expect(captured.lines).toHaveLength(1)
    expect(JSON.stringify(captured.lines[0]?.record)).not.toContain(digits)
    expect(captured.lines[0]?.record).toMatchObject({ metric: "job_done", firmId: "firm_1" })
  })

  it("does not export a line writer", () => {
    expect(observability).not.toHaveProperty("createLineSink")
    const dir = path.resolve(__dirname, "../platform/observability")
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      expect(readFileSync(path.join(dir, name), "utf8")).not.toContain("createLineSink")
    }
    const lines: string[] = []
    const sink: SignalSink = (record) => lines.push(JSON.stringify(record))
    exercise(createObservability({ env: {}, logSink: sink }))
    expect(lines).toEqual([])
    exercise(createObservability({ env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" }, logSink: sink }))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(password)
    expect(lines[0]).not.toContain(email)
  })

  it("does not read caller data when the exporter is off, and drops a throwing record when it is on", () => {
    let reads = 0
    const boom = () => {
      reads += 1
      throw new Error("getter")
    }
    const fields: Record<string, unknown> = {}
    Object.defineProperty(fields, "code", { enumerable: true, get: boom })
    const attrs = new Proxy(
      { firmId: "firm_1" },
      {
        ownKeys() {
          reads += 1
          throw new Error("ownKeys")
        },
        get: boom,
      },
    )
    const err = new Proxy(new Error("x"), { get: boom })
    const off = createObservability({
      env: {},
      logSink: () => {
        throw new Error("sink")
      },
    })
    expect(() => off.log("info", "job_done", fields)).not.toThrow()
    const span = off.startSpan("job_run", attrs)
    expect(() => span.setAttribute("code", err)).not.toThrow()
    expect(() => span.recordException(err)).not.toThrow()
    expect(() => span.end("error")).not.toThrow()
    expect(reads).toBe(0)

    const lines: unknown[] = []
    const on = createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled", [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      logSink: (record) => lines.push(record),
      traceSink: (record) => lines.push(record),
    })
    expect(() => on.log("info", "job_done", fields)).not.toThrow()
    const live = on.startSpan("job_run", attrs)
    expect(() => live.recordException(err)).not.toThrow()
    expect(() => live.end("error")).not.toThrow()
    expect(lines).toEqual([])

    expect(() =>
      createObservability({
        env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
        logSink: () => {
          throw new Error("sink")
        },
      }).log("info", "job_done", { firmId: "firm_1" }),
    ).not.toThrow()
  })

  it("redacts the audited token-shaped leaks before they reach a sink", () => {
    const leaks = [
      "42101" + "_1234567_" + "1",
      "42101" + ":1234567:" + "1",
      "user" + "4210112345671",
      "92-300-1234567",
      "0300-123-4567",
      "3001234567",
      "AIza" + "SyShortKey12",
      "akia" + "examplekey1",
      "wJalr" + "XUtnFEMI" + "/K7MDENG" + "/bPxRfiCY" + "EXAMPLEKEY",
      "github_pat_" + "abc",
      "whsec_" + "abcdef",
      "0123456789abcdef".repeat(4),
      "eyJ" + "hbGciOiJub25lIn0",
      "eyJ" + "ImEiOjF9abcd",
      "c2ln" + "YXR1cmVhYmNkZWZnaA",
      "Basic " + "dXNlcjpw",
    ]
    const captured = sinks()
    const obs = createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: captured.log,
    })
    for (const leak of leaks) {
      captured.lines.length = 0
      obs.log("info", "job_done", { code: leak, reason: leak, firmId: "firm_1" })
      expect(captured.lines).toHaveLength(1)
      const text = JSON.stringify(captured.lines[0]?.record)
      expect(text).not.toContain(leak)
      expect(text).toContain("firm_1")
    }
    const named = new Error("boom")
    named.name = "Ayesha_Khan_" + "4210112345671"
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run")
    span.recordException(named)
    span.end("error")
    const spanText = JSON.stringify(traces.lines)
    expect(spanText).not.toContain("Ayesha")
    expect(spanText).not.toContain("4210112345671")
    expect(traces.lines[0]?.record).toMatchObject({ errorName: REDACTED })

    const metrics = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: metrics.metrics,
    }).histogram("job_duration_ms", 4210112345.671, { firmId: "firm_1" })
    expect(JSON.stringify(metrics.lines)).not.toContain("4210112345")
    expect(metrics.lines[0]?.record).toMatchObject({ metric: "job_duration_ms", firmId: "firm_1" })
  })

  it("does not let caller fields replace signal, level, metric or value", () => {
    const logs = sinks()
    createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: logs.log,
    }).log("info", "job_done", { signal: "metric", level: "debug", event: "other_event", value: 5, firmId: "firm_1" })
    expect(logs.lines[0]?.record).toMatchObject({
      signal: "log",
      level: "info",
      event: "job_done",
      firmId: "firm_1",
    })

    const metrics = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: metrics.metrics,
    }).histogram("job_duration_ms", 12, { signal: "log", metric: "other_metric", unit: "count", value: 999 })
    expect(metrics.lines[0]?.record).toMatchObject({
      signal: "metric",
      metric: "job_duration_ms",
      unit: "ms",
      value: 12,
    })
  })

  it("does not write to the console when a record is dropped", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined)
    const fields: Record<string, unknown> = {}
    Object.defineProperty(fields, "code", {
      enumerable: true,
      get() {
        throw new Error("getter")
      },
    })
    expect(() =>
      createObservability({
        env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
        logSink: () => {
          throw new Error("sink")
        },
      }).log("info", "job_done", fields),
    ).not.toThrow()
    expect(log).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })

  it("does not copy caller errorName onto a span", () => {
    const leaked = "AyeshaKhan" + "4210112345671"
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { errorName: leaked, errorCode: "grpc_3", firmId: "firm_1" })
    span.end("ok")
    const text = JSON.stringify(traces.lines)
    expect(text).not.toContain("Ayesha")
    expect(text).not.toContain(leaked)
    expect(traces.lines[0]?.record).toMatchObject({ firmId: "firm_1", event: "job_run" })
    expect(traces.lines[0]?.record).not.toHaveProperty("errorName")
    expect(traces.lines[0]?.record).not.toHaveProperty("errorCode")
  })

  it("does not let a folded caller key replace a reserved field", () => {
    const logs = sinks()
    createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: logs.log,
    }).log("info", "job_done", { level: "x", LEVEL: "debug", firmId: "firm_1" })
    expect(logs.lines[0]?.record).toMatchObject({ level: "info", signal: "log", event: "job_done", firmId: "firm_1" })

    const metrics = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: metrics.metrics,
    }).counter("job_done", 0, { value: 0, VALUE: 999, firmId: "firm_1" })
    expect(metrics.lines[0]?.record).toMatchObject({ value: 0, signal: "metric", metric: "job_done", firmId: "firm_1" })

    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { traceId: "x", Trace_Id: "not-the-real-trace", firmId: "firm_1" })
    span.setAttribute("STATUS", "error")
    span.setAttribute("status", "error")
    span.end("ok")
    expect(traces.lines[0]?.record).toMatchObject({
      traceId: span.traceId,
      spanId: span.spanId,
      status: "ok",
      signal: "trace",
      event: "job_run",
      firmId: "firm_1",
    })
    expect(JSON.stringify(traces.lines)).not.toContain("not-the-real-trace")
  })

  it("does not read a throwing name while every exporter is off", () => {
    const bad = {
      toString() {
        throw new Error("name")
      },
    }
    const off = createObservability()
    expect(() => off.log("info", bad as unknown as string)).not.toThrow()
    expect(() => off.counter(bad as unknown as string)).not.toThrow()
    expect(() => off.histogram(bad as unknown as string, 1)).not.toThrow()
    const span = off.startSpan(bad as unknown as string)
    expect(() => span.end("ok")).not.toThrow()

    const logs = sinks()
    expect(() =>
      createObservability({
        env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
        logSink: logs.log,
      }).log("info", bad as unknown as string, { firmId: "firm_1" }),
    ).not.toThrow()
    expect(logs.lines[0]?.record).toMatchObject({ event: "invalid", firmId: "firm_1" })
  })

  it("does not copy an identifier-sized error code onto a span", () => {
    const cnic = "42101" + "1234567" + "1"
    const err = new Error("boom")
    ;(err as Error & { code: string }).code = cnic
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { firmId: "firm_1" })
    span.recordException(err)
    span.end("error")
    expect(traces.lines[0]?.record).not.toHaveProperty("errorCode")
    expect(JSON.stringify(traces.lines)).not.toContain(cnic)
    expect(traces.lines[0]?.record).toMatchObject({ status: "error", firmId: "firm_1" })
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
