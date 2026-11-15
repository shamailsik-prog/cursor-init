/**
 * Structured logging, metrics and tracing for services (Q15a).
 *
 * Each exporter is off unless its flag is exactly `enabled` (the same
 * fail-closed exactness as `OPIK_SELF_HOSTED_CONFIRMED` in `functions/src/p1/opik.ts`).
 * Unset, `true`, `1`, `on`, `ENABLED`, and any padded or whitespace-bearing
 * value leave the sink uncalled. The comparison is exact: nothing is trimmed.
 * There is no network exporter: a caller-supplied sink is the only way a
 * redacted record can leave, and only after the flag is on.
 */

import { randomUUID } from "node:crypto"
import { normalizeFieldKey, redactForObservability } from "@/platform/observability/redact"

export const OBS_LOG_EXPORTER_FLAG = "LEGAL_OS_OBS_LOG_EXPORTER"
export const OBS_METRICS_EXPORTER_FLAG = "LEGAL_OS_OBS_METRICS_EXPORTER"
export const OBS_TRACE_EXPORTER_FLAG = "LEGAL_OS_OBS_TRACE_EXPORTER"

/** The only value that turns an exporter on. Compared exactly, with no trim. */
export const OBS_EXPORTER_ENABLED_VALUE = "enabled"

export type SignalSink = (record: Readonly<Record<string, unknown>>) => void

export type LogLevel = "debug" | "info" | "warn" | "error"

export type Span = {
  readonly traceId: string
  readonly spanId: string
  setAttribute(key: string, value: unknown): void
  recordException(error: unknown): void
  end(status?: "ok" | "error"): void
}

export type Observability = {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void
  counter(name: string, value?: number, attributes?: Record<string, unknown>): void
  histogram(name: string, value: number, attributes?: Record<string, unknown>): void
  startSpan(name: string, attributes?: Record<string, unknown>): Span
}

export type ObservabilityOptions = {
  env?: NodeJS.ProcessEnv
  logSink?: SignalSink
  metricsSink?: SignalSink
  traceSink?: SignalSink
}

const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

export function exporterEnabled(env: NodeJS.ProcessEnv, flag: string): boolean {
  return env[flag] === OBS_EXPORTER_ENABLED_VALUE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const LOG_RESERVED = ["signal", "level", "event"] as const
const METRIC_RESERVED = ["signal", "metric", "unit", "value"] as const
const TRACE_RESERVED = ["signal", "event", "traceId", "spanId", "status", "durationMs"] as const

function omitReserved(
  fields: Record<string, unknown> | undefined,
  reserved: readonly string[],
): Record<string, unknown> {
  const blocked = new Set(reserved.map((field) => normalizeFieldKey(field)))
  const out: Record<string, unknown> = {}
  if (fields === undefined) return out
  for (const [key, value] of Object.entries(fields)) {
    if (blocked.has(normalizeFieldKey(key))) continue
    out[key] = value
  }
  return out
}

function safeName(name: unknown): string {
  if (typeof name !== "string") return "invalid"
  return NAME.test(name) ? name : "invalid"
}

/**
 * Off, or no sink: return before the builder runs, so caller fields are not read.
 * On: build, redact and deliver inside one try. A throwing getter, proxy or sink
 * drops the record and does not reach the caller.
 */
type BuiltRecord = {
  record: Record<string, unknown>
  errorName?: unknown
  errorCode?: unknown
}

function deliver(enabled: boolean, sink: SignalSink | undefined, build: () => BuiltRecord): void {
  if (!enabled || sink === undefined) return
  try {
    const built = build()
    const redacted = redactForObservability(built.record)
    if (!isRecord(redacted)) return
    if (typeof built.errorName === "string") redacted.errorName = built.errorName
    if (typeof built.errorCode === "string" || typeof built.errorCode === "number") redacted.errorCode = built.errorCode
    sink(redacted)
  } catch {
    // Drop the record. The caller is not told.
  }
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  const env = options.env ?? process.env
  const logOn = exporterEnabled(env, OBS_LOG_EXPORTER_FLAG)
  const metricsOn = exporterEnabled(env, OBS_METRICS_EXPORTER_FLAG)
  const traceOn = exporterEnabled(env, OBS_TRACE_EXPORTER_FLAG)

  function metric(unit: "count" | "ms", name: string, value: number, attributes?: Record<string, unknown>): void {
    deliver(metricsOn, options.metricsSink, () => ({
      record: {
        ...omitReserved(attributes, METRIC_RESERVED),
        signal: "metric",
        metric: safeName(name),
        unit,
        value,
      },
    }))
  }

  return {
    log(level, event, fields) {
      const safeLevel = level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "error"
      deliver(logOn, options.logSink, () => ({
        record: {
          ...omitReserved(fields, LOG_RESERVED),
          signal: "log",
          level: safeLevel,
          event: safeName(event),
        },
      }))
    },
    counter(name, value = 1, attributes) {
      metric("count", name, value, attributes)
    },
    histogram(name, value, attributes) {
      metric("ms", name, value, attributes)
    },
    startSpan(name, attributes) {
      const started = performance.now()
      const traceId = randomUUID()
      const spanId = randomUUID()
      const overrides = new Map<string, unknown>()
      let exception: unknown
      let ended = false
      const traceLive = traceOn && options.traceSink !== undefined
      return {
        traceId,
        spanId,
        setAttribute(key, value) {
          if (ended || !traceLive) return
          overrides.set(key, value)
        },
        recordException(error) {
          if (ended || !traceLive) return
          exception = error
        },
        end(status) {
          if (ended) return
          ended = true
          deliver(traceOn, options.traceSink, () => {
            const merged = omitReserved(attributes, TRACE_RESERVED)
            const blocked = new Set(TRACE_RESERVED.map((field) => normalizeFieldKey(field)))
            for (const [key, value] of overrides) {
              if (blocked.has(normalizeFieldKey(key))) continue
              merged[key] = value
            }
            let errorName: unknown
            let errorCode: unknown
            if (exception !== undefined) {
              const redactedErr = redactForObservability(exception)
              if (isRecord(redactedErr)) {
                errorName = redactedErr.errorName
                errorCode = redactedErr.errorCode
              }
            }
            return {
              record: {
                ...merged,
                signal: "trace",
                event: safeName(name),
                traceId,
                spanId,
                status: status === "error" ? "error" : "ok",
                durationMs: Math.max(0, Math.round(performance.now() - started)),
              },
              errorName,
              errorCode,
            }
          })
        },
      }
    },
  }
}
