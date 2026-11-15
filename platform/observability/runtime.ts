/**
 * Structured logging, metrics and tracing for services (Q15a).
 *
 * Each exporter is off unless its flag is exactly `enabled` (the same
 * fail-closed exactness as `OPIK_SELF_HOSTED_CONFIRMED` in `functions/src/p1/opik.ts`).
 * Unset, `true`, `1`, `on` and any other value leave the sink uncalled.
 * There is no network exporter: a caller-supplied sink is the only way a
 * redacted record can leave, and only after the flag is on.
 */

import { randomUUID } from "node:crypto"
import { redactForObservability } from "@/platform/observability/redact"

export const OBS_LOG_EXPORTER_FLAG = "LEGAL_OS_OBS_LOG_EXPORTER"
export const OBS_METRICS_EXPORTER_FLAG = "LEGAL_OS_OBS_METRICS_EXPORTER"
export const OBS_TRACE_EXPORTER_FLAG = "LEGAL_OS_OBS_TRACE_EXPORTER"

/** The only value that turns an exporter on. Compared after trimming. */
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

const NAME = /^[a-z][a-z0-9_.]{0,63}$/

export function exporterEnabled(env: NodeJS.ProcessEnv, flag: string): boolean {
  const raw = env[flag]
  return typeof raw === "string" && raw.trim() === OBS_EXPORTER_ENABLED_VALUE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeName(name: string): string {
  return NAME.test(name) ? name : "invalid"
}

function emit(enabled: boolean, sink: SignalSink | undefined, record: Record<string, unknown>): void {
  if (!enabled || sink === undefined) return
  const redacted = redactForObservability(record)
  if (isRecord(redacted)) sink(redacted)
}

/** One JSON line. Writes nothing until a flag turns the sink on. */
export function createLineSink(write: (line: string) => void): SignalSink {
  return (record) => {
    write(`${JSON.stringify(record)}\n`)
  }
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  const env = options.env ?? process.env
  const logOn = exporterEnabled(env, OBS_LOG_EXPORTER_FLAG)
  const metricsOn = exporterEnabled(env, OBS_METRICS_EXPORTER_FLAG)
  const traceOn = exporterEnabled(env, OBS_TRACE_EXPORTER_FLAG)

  function metric(unit: "count" | "ms", name: string, value: number, attributes?: Record<string, unknown>): void {
    emit(metricsOn, options.metricsSink, {
      ...attributes,
      signal: "metric",
      metric: safeName(name),
      unit,
      value,
    })
  }

  return {
    log(level, event, fields) {
      const safeLevel = level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "error"
      emit(logOn, options.logSink, {
        ...fields,
        signal: "log",
        level: safeLevel,
        event: safeName(event),
      })
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
      const attrs: Record<string, unknown> = { ...attributes }
      let errorName: unknown
      let errorCode: unknown
      let ended = false
      return {
        traceId,
        spanId,
        setAttribute(key, value) {
          if (!ended) attrs[key] = value
        },
        recordException(error) {
          if (ended) return
          const redacted = redactForObservability(error)
          if (!isRecord(redacted)) return
          errorName = redacted.errorName
          errorCode = redacted.errorCode
        },
        end(status) {
          if (ended) return
          ended = true
          const durationMs = Math.max(0, Math.round(performance.now() - started))
          emit(traceOn, options.traceSink, {
            ...attrs,
            signal: "trace",
            event: safeName(name),
            traceId,
            spanId,
            status: status === "error" ? "error" : "ok",
            durationMs,
            ...(errorName === undefined ? {} : { errorName }),
            ...(errorCode === undefined ? {} : { errorCode }),
          })
          for (const key of Object.keys(attrs)) delete attrs[key]
        },
      }
    },
  }
}
