resource "google_monitoring_notification_channel" "oncall" {
  display_name = "On-call email"
  type         = "email"
  labels = {
    email_address = var.oncall_email
  }
}

resource "google_monitoring_alert_policy" "log_deploy_contract_violation" {
  display_name = "ERROR log event deploy.contract_violation"
  combiner     = "OR"
  conditions {
    display_name = "deploy.contract_violation"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"deploy.contract_violation\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_reservation_exceeded" {
  display_name = "ERROR log event p1.reservation_exceeded"
  combiner     = "OR"
  conditions {
    display_name = "p1.reservation_exceeded"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.reservation_exceeded\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_usage_log_failed" {
  display_name = "ERROR log event p1.usage_log_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.usage_log_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.usage_log_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_corpus_embedding_not_configured" {
  display_name = "ERROR log event p1.corpus_embedding_not_configured"
  combiner     = "OR"
  conditions {
    display_name = "p1.corpus_embedding_not_configured"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.corpus_embedding_not_configured\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_corpus_embedding_failed" {
  display_name = "ERROR log event p1.corpus_embedding_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.corpus_embedding_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.corpus_embedding_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_receipt_record_failed" {
  display_name = "ERROR log event p1.receipt_record_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.receipt_record_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.receipt_record_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_overhead_learned" {
  display_name = "ERROR log event p1.overhead_learned"
  combiner     = "OR"
  conditions {
    display_name = "p1.overhead_learned"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.overhead_learned\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_overhead_anomaly" {
  display_name = "ERROR log event p1.overhead_anomaly"
  combiner     = "OR"
  conditions {
    display_name = "p1.overhead_anomaly"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.overhead_anomaly\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_reconcile_failed" {
  display_name = "ERROR log event p1.reconcile_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.reconcile_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.reconcile_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_reconcile_quarantined" {
  display_name = "ERROR log event p1.reconcile_quarantined"
  combiner     = "OR"
  conditions {
    display_name = "p1.reconcile_quarantined"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.reconcile_quarantined\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_reconcile_failure_uncounted" {
  display_name = "ERROR log event p1.reconcile_failure_uncounted"
  combiner     = "OR"
  conditions {
    display_name = "p1.reconcile_failure_uncounted"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.reconcile_failure_uncounted\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_reconcile_pass_failed" {
  display_name = "ERROR log event p1.reconcile_pass_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.reconcile_pass_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.reconcile_pass_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_trace_export_abandoned" {
  display_name = "ERROR log event p1.trace_export_abandoned"
  combiner     = "OR"
  conditions {
    display_name = "p1.trace_export_abandoned"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.trace_export_abandoned\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_p1_trace_export_reconcile_failed" {
  display_name = "ERROR log event p1.trace_export_reconcile_failed"
  combiner     = "OR"
  conditions {
    display_name = "p1.trace_export_reconcile_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"p1.trace_export_reconcile_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p1/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_autoconfirm_backlog_stale" {
  display_name = "ERROR log event autoconfirm.backlog_stale"
  combiner     = "OR"
  conditions {
    display_name = "autoconfirm.backlog_stale"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"autoconfirm.backlog_stale\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p2/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_job_deadLettered" {
  display_name = "ERROR log event job.deadLettered"
  combiner     = "OR"
  conditions {
    display_name = "job.deadLettered"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"job.deadLettered\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/p2/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_audit_outbox_backlog_stale" {
  display_name = "ERROR log event audit.outbox_backlog_stale"
  combiner     = "OR"
  conditions {
    display_name = "audit.outbox_backlog_stale"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"audit.outbox_backlog_stale\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_audit_outbox_dead_lettered" {
  display_name = "ERROR log event audit.outbox_dead_lettered"
  combiner     = "OR"
  conditions {
    display_name = "audit.outbox_dead_lettered"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"audit.outbox_dead_lettered\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_audit_outbox_row_dead_lettered" {
  display_name = "ERROR log event audit.outbox_row_dead_lettered"
  combiner     = "OR"
  conditions {
    display_name = "audit.outbox_row_dead_lettered"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"audit.outbox_row_dead_lettered\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_audit_outbox_reconcile_failed" {
  display_name = "ERROR log event audit.outbox_reconcile_failed"
  combiner     = "OR"
  conditions {
    display_name = "audit.outbox_reconcile_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"audit.outbox_reconcile_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_audit_outbox_sweep_failed" {
  display_name = "ERROR log event audit.outbox_sweep_failed"
  combiner     = "OR"
  conditions {
    display_name = "audit.outbox_sweep_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"audit.outbox_sweep_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: docs/deploy/RELEASE_RUNBOOK.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_ops_alert_notified" {
  display_name = "ERROR log event ops_alert.notified"
  combiner     = "OR"
  conditions {
    display_name = "ops_alert.notified"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"ops_alert.notified\""
      label_extractors = {
        page_id = "EXTRACT(jsonPayload.pageId)"
      }
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/alerts/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_ops_alert_raise_failed" {
  display_name = "ERROR log event ops_alert.raise_failed"
  combiner     = "OR"
  conditions {
    display_name = "ops_alert.raise_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"ops_alert.raise_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/alerts/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}

resource "google_monitoring_alert_policy" "log_ops_alert_pass_failed" {
  display_name = "ERROR log event ops_alert.pass_failed"
  combiner     = "OR"
  conditions {
    display_name = "ops_alert.pass_failed"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND severity=\"ERROR\" AND jsonPayload.event=\"ops_alert.pass_failed\""
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }
  documentation {
    content   = "Runbook: functions/src/alerts/README.md"
    mime_type = "text/markdown"
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}
