resource "google_monitoring_notification_channel" "oncall" {
  display_name = "On-call email"
  type         = "email"
  labels = {
    email_address = var.oncall_email
  }
}

resource "google_monitoring_alert_policy" "functions_errors" {
  display_name = "Cloud Functions ERROR log events"
  combiner     = "OR"
  conditions {
    display_name = "deploy.contract_violation"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="deploy.contract_violation"'
    }
  }
  conditions {
    display_name = "p1.reservation_exceeded"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.reservation_exceeded"'
    }
  }
  conditions {
    display_name = "p1.usage_log_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.usage_log_failed"'
    }
  }
  conditions {
    display_name = "p1.corpus_embedding_not_configured"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.corpus_embedding_not_configured"'
    }
  }
  conditions {
    display_name = "p1.corpus_embedding_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.corpus_embedding_failed"'
    }
  }
  conditions {
    display_name = "p1.receipt_record_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.receipt_record_failed"'
    }
  }
  conditions {
    display_name = "p1.overhead_learned"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.overhead_learned"'
    }
  }
  conditions {
    display_name = "p1.overhead_anomaly"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.overhead_anomaly"'
    }
  }
  conditions {
    display_name = "p1.reconcile_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.reconcile_failed"'
    }
  }
  conditions {
    display_name = "p1.reconcile_quarantined"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.reconcile_quarantined"'
    }
  }
  conditions {
    display_name = "p1.reconcile_failure_uncounted"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.reconcile_failure_uncounted"'
    }
  }
  conditions {
    display_name = "p1.reconcile_pass_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.reconcile_pass_failed"'
    }
  }
  conditions {
    display_name = "p1.trace_export_abandoned"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.trace_export_abandoned"'
    }
  }
  conditions {
    display_name = "p1.trace_export_reconcile_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="p1.trace_export_reconcile_failed"'
    }
  }
  conditions {
    display_name = "autoconfirm.backlog_stale"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="autoconfirm.backlog_stale"'
    }
  }
  conditions {
    display_name = "job.deadLettered"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="job.deadLettered"'
    }
  }
  conditions {
    display_name = "audit.outbox_backlog_stale"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="audit.outbox_backlog_stale"'
    }
  }
  conditions {
    display_name = "audit.outbox_dead_lettered"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="audit.outbox_dead_lettered"'
    }
  }
  conditions {
    display_name = "audit.outbox_row_dead_lettered"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="audit.outbox_row_dead_lettered"'
    }
  }
  conditions {
    display_name = "audit.outbox_reconcile_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="audit.outbox_reconcile_failed"'
    }
  }
  conditions {
    display_name = "audit.outbox_sweep_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="audit.outbox_sweep_failed"'
    }
  }
  conditions {
    display_name = "ops_alert.notified"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="ops_alert.notified"'
    }
  }
  conditions {
    display_name = "ops_alert.raise_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="ops_alert.raise_failed"'
    }
  }
  conditions {
    display_name = "ops_alert.pass_failed"
    condition_matched_log {
      filter = 'resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.message="ops_alert.pass_failed"'
    }
  }
  notification_channels = [google_monitoring_notification_channel.oncall.name]
}
