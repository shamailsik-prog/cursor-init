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
  mintUuid,
  type SignalSink,
} from "@/platform/observability"

/**
 * Q15a: every exporter is off unless its flag is exactly "enabled".
 * With no config, a log, a metric and a span stay inside the process.
 */

const FLAGS = [OBS_LOG_EXPORTER_FLAG, OBS_METRICS_EXPORTER_FLAG, OBS_TRACE_EXPORTER_FLAG] as const

const password = "hun" + "ter2"
const firm = mintUuid()
const email = "person" + "@" + "example.com"

function sinks(): { log: SignalSink; metrics: SignalSink; trace: SignalSink; lines: { sink: string; record: unknown }[] } {
  const lines: { sink: string; record: unknown }[] = []
  const capture = (sink: string): SignalSink => (record) => {
    lines.push({ sink, record })
  }
  return { log: capture("log"), metrics: capture("metrics"), trace: capture("trace"), lines }
}

function exercise(obs: ReturnType<typeof createObservability>): void {
  obs.log("info", "job_done", { firmId: firm, password, email })
  obs.counter("job_done", 1, { firmId: firm, password })
  obs.histogram("job_duration_ms", 12, { email })
  const span = obs.startSpan("job_run", { firmId: firm, documentText: "SECRET_PLEADING" })
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
    expect(record).toMatchObject({ signal: "log", level: "info", event: "job_done", firmId: firm.text })
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
    expect(span).toMatchObject({ signal: "trace", event: "job_run", firmId: firm.text, status: "ok" })
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
    obs.log("INFO" as "info", "Job Done", { firmId: firm })
    expect(captured.lines[0]?.record).toMatchObject({ level: "error", event: "invalid", firmId: firm.text })
    const span = obs.startSpan("job_run", { firmId: firm })
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
      }).log("info", "job_done", { firmId: firm, code: child }),
    ).not.toThrow()
    expect(reads).toBe(0)
    expect(captured.lines[0]?.record).toMatchObject({ firmId: firm.text, code: REDACTED })
  })

  it("does not export an identifier-length number as a metric value", () => {
    const digits = "35202" + "1234567" + "1"
    const captured = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: captured.metrics,
    }).counter("job_done", Number(digits), { firmId: firm })
    expect(captured.lines).toHaveLength(1)
    expect(JSON.stringify(captured.lines[0]?.record)).not.toContain(digits)
    expect(captured.lines[0]?.record).toMatchObject({ metric: "job_done", firmId: firm.text })
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
      { firmId: firm },
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
      }).log("info", "job_done", { firmId: firm }),
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
      obs.log("info", "job_done", { code: leak, reason: leak, firmId: firm })
      expect(captured.lines).toHaveLength(1)
      const text = JSON.stringify(captured.lines[0]?.record)
      expect(text).not.toContain(leak)
      expect(text).toContain(firm.text)
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
    }).histogram("job_duration_ms", 4210112345.671, { firmId: firm })
    expect(JSON.stringify(metrics.lines)).not.toContain("4210112345")
    expect(metrics.lines[0]?.record).toMatchObject({ metric: "job_duration_ms", firmId: firm.text })
  })

  it("does not let caller fields replace signal, level, metric or value", () => {
    const logs = sinks()
    createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: logs.log,
    }).log("info", "job_done", { signal: "metric", level: "debug", event: "other_event", value: 5, firmId: firm })
    expect(logs.lines[0]?.record).toMatchObject({
      signal: "log",
      level: "info",
      event: "job_done",
      firmId: firm.text,
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
    }).startSpan("job_run", { errorName: leaked, errorCode: "grpc_3", firmId: firm })
    span.end("ok")
    const text = JSON.stringify(traces.lines)
    expect(text).not.toContain("Ayesha")
    expect(text).not.toContain(leaked)
    expect(traces.lines[0]?.record).toMatchObject({ firmId: firm.text, event: "job_run" })
    expect(traces.lines[0]?.record).not.toHaveProperty("errorName")
    expect(traces.lines[0]?.record).not.toHaveProperty("errorCode")
  })

  it("does not let a folded caller key replace a reserved field", () => {
    const logs = sinks()
    createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: logs.log,
    }).log("info", "job_done", { level: "x", LEVEL: "debug", firmId: firm })
    expect(logs.lines[0]?.record).toMatchObject({ level: "info", signal: "log", event: "job_done", firmId: firm.text })

    const metrics = sinks()
    createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: metrics.metrics,
    }).counter("job_done", 0, { value: 0, VALUE: 999, firmId: firm })
    expect(metrics.lines[0]?.record).toMatchObject({ value: 0, signal: "metric", metric: "job_done", firmId: firm.text })

    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { traceId: "x", Trace_Id: "not-the-real-trace", firmId: firm })
    span.setAttribute("STATUS", "error")
    span.setAttribute("status", "error")
    span.end("ok")
    expect(traces.lines[0]?.record).toMatchObject({
      traceId: span.traceId,
      spanId: span.spanId,
      status: "ok",
      signal: "trace",
      event: "job_run",
      firmId: firm.text,
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
      }).log("info", bad as unknown as string, { firmId: firm }),
    ).not.toThrow()
    expect(logs.lines[0]?.record).toMatchObject({ event: "invalid", firmId: firm.text })
  })

  it("does not copy an identifier-sized error code onto a span", () => {
    const cnic = "42101" + "1234567" + "1"
    const err = new Error("boom")
    ;(err as Error & { code: string }).code = cnic
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { firmId: firm })
    span.recordException(err)
    span.end("error")
    expect(traces.lines[0]?.record).not.toHaveProperty("errorCode")
    expect(JSON.stringify(traces.lines)).not.toContain(cnic)
    expect(traces.lines[0]?.record).toMatchObject({ status: "error", firmId: firm.text })
  })

  it("Q15b L1 does not let a folded VALUE or DURATION_MS fill a dropped reserved field", () => {
    const metrics = sinks()
    const obs = createObservability({
      env: { [OBS_METRICS_EXPORTER_FLAG]: "enabled" },
      metricsSink: metrics.metrics,
    })
    obs.counter("c", 1e9, { VALUE: 5 })
    expect(metrics.lines[0]?.record).not.toHaveProperty("value")
    expect(JSON.stringify(metrics.lines[0]?.record)).not.toContain("5")

    metrics.lines.length = 0
    obs.counter("c", Number.NaN, { Value: 7 })
    expect(metrics.lines[0]?.record).not.toHaveProperty("value")
    expect(JSON.stringify(metrics.lines[0]?.record)).not.toContain("7")

    metrics.lines.length = 0
    obs.counter("c", 1e9, { "V-A-L-U-E": 5 })
    expect(metrics.lines[0]?.record).not.toHaveProperty("value")

    let clock = 0
    vi.spyOn(performance, "now").mockImplementation(() => clock)
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { DURATION_MS: 12 })
    clock = 86_400_001
    span.setAttribute("Duration_Ms", 12)
    span.setAttribute("DURATION-MS", 12)
    span.end("ok")
    const record = traces.lines[0]?.record as Record<string, unknown>
    expect(record).not.toHaveProperty("durationMs")
    expect(JSON.stringify(record)).not.toContain("durationMs")
    expect(JSON.stringify(record)).not.toContain("DURATION")
  })

  it("Q15b L4 drops dead hyphen prefixes and keeps the live ones", () => {
    const source = readFileSync(path.resolve(__dirname, "../platform/observability/redact.ts"), "utf8")
    for (const dead of ['"key-"', '"sess-"', '"xoxa-"', '"xoxr-"', '"xoxs-"']) {
      expect(source).not.toContain(dead)
    }
    for (const live of ['"xoxb-"', '"xoxp-"', '"sk_live_"', '"akia"', '"asia"', '"aiza"']) {
      expect(source).toContain(live)
    }
  })

  it("Q02 keeps the 64-character cap on minted registry text", () => {
    const source = readFileSync(path.resolve(__dirname, "../platform/observability/redact.ts"), "utf8")
    expect(source).toContain("record.text.length > 0 && record.text.length <= 64")
  })

  function paths(attack: unknown, matter: unknown): { log: Record<string, unknown>; span: Record<string, unknown> } {
    const phone = "0300" + "1234567"
    const logs = sinks()
    createObservability({
      env: { [OBS_LOG_EXPORTER_FLAG]: "enabled" },
      logSink: logs.log,
    }).log("info", "job_done", { firmId: attack })
    const traces = sinks()
    const span = createObservability({
      env: { [OBS_TRACE_EXPORTER_FLAG]: "enabled" },
      traceSink: traces.trace,
    }).startSpan("job_run", { firmId: attack })
    span.setAttribute("matterId", matter)
    span.end("ok")
    const log = logs.lines[0]?.record as Record<string, unknown>
    const traced = traces.lines[0]?.record as Record<string, unknown>
    expect(JSON.stringify(log)).not.toContain(phone)
    expect(JSON.stringify(traced)).not.toContain(phone)
    return { log, span: traced }
  }

  it("Q15b R2 redacts a spread copy of a minted id", () => {
    const phone = "0300" + "1234567"
    const copy = () => ({ ...mintUuid(), text: phone })
    const { log, span } = paths(copy(), copy())
    expect(log.firmId).toBe(REDACTED)
    expect(span.firmId).toBe(REDACTED)
    expect(span.matterId).toBe(REDACTED)
  })

  it("Q15b R2 redacts an Object.assign copy of a minted id", () => {
    const phone = "0300" + "1234567"
    const copy = () => Object.assign({}, mintUuid(), { text: phone })
    const { log, span } = paths(copy(), copy())
    expect(log.firmId).toBe(REDACTED)
    expect(span.firmId).toBe(REDACTED)
    expect(span.matterId).toBe(REDACTED)
  })

  it("Q15b R2 does not let a caller mutate minted text", () => {
    const phone = "0300" + "1234567"
    const minted = mintUuid()
    const original = minted.text
    expect(Object.isFrozen(minted)).toBe(true)
    expect(() => {
      ;(minted as { text: string }).text = phone
    }).toThrow()
    expect(minted.text).toBe(original)
    const { log, span } = paths(minted, minted)
    expect(log.firmId).toBe(original)
    expect(span.firmId).toBe(original)
    expect(span.matterId).toBe(original)
  })

  it("Q15b R2 redacts a symbol-forged minted id", () => {
    const phone = "0300" + "1234567"
    const sym = Object.getOwnPropertySymbols(mintUuid())[0]
    expect(typeof sym).toBe("symbol")
    const forged = () => ({ text: phone, [sym]: true })
    const { log, span } = paths(forged(), forged())
    expect(log.firmId).toBe(REDACTED)
    expect(span.firmId).toBe(REDACTED)
    expect(span.matterId).toBe(REDACTED)
  })

  it("Q15b R2 redacts a Proxy that claims every symbol", () => {
    const phone = "0300" + "1234567"
    const proxy = () => new Proxy({}, { get: (_target, key) => (typeof key === "symbol" ? true : phone) })
    const { log, span } = paths(proxy(), proxy())
    expect(log.firmId).toBe(REDACTED)
    expect(span.firmId).toBe(REDACTED)
    expect(span.matterId).toBe(REDACTED)
  })

  it("Q15b R2 redacts a getter that changes text between check and copy", () => {
    const phone = "0300" + "1234567"
    const toctou = () => {
      const sym = Object.getOwnPropertySymbols(mintUuid())[0]
      let reads = 0
      return {
        [sym]: true,
        get text() {
          reads += 1
          return reads === 1 ? "ok" : phone
        },
      }
    }
    const { log, span } = paths(toctou(), toctou())
    expect(log.firmId).toBe(REDACTED)
    expect(span.firmId).toBe(REDACTED)
    expect(span.matterId).toBe(REDACTED)
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
