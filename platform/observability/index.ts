export {
  OBSERVABILITY_FIELDS,
  REDACTED,
  normalizeFieldKey,
  redactForObservability,
  type ObservabilityField,
} from "@/platform/observability/redact"

export {
  OBS_EXPORTER_ENABLED_VALUE,
  OBS_LOG_EXPORTER_FLAG,
  OBS_METRICS_EXPORTER_FLAG,
  OBS_TRACE_EXPORTER_FLAG,
  createLineSink,
  createObservability,
  exporterEnabled,
  type LogLevel,
  type Observability,
  type ObservabilityOptions,
  type SignalSink,
  type Span,
} from "@/platform/observability/runtime"
