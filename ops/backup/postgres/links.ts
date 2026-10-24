/** Logical orphan counts (R9); each SQL must parse against corpus DDL. */
export type PgLinkCheck = {
  name: string
  /** Tables referenced (schema-qualified or public bare names) for the DDL unit test. */
  tables: string[]
  sql: string
}

export const PG_LINK_CHECKS: PgLinkCheck[] = [
  {
    name: "staging_published_case",
    tables: ["scraper_staging", "case_law_master"],
    sql: `SELECT count(*)::bigint FROM scraper_staging s
      WHERE s.lifecycle_state IN ('published','embedded')
        AND s.published_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM case_law_master m WHERE m.id = s.published_id)`,
  },
  {
    name: "staging_published_statute",
    tables: ["statutes_staging", "statutes_master"],
    sql: `SELECT count(*)::bigint FROM statutes_staging s
      WHERE s.lifecycle_state IN ('published','embedded')
        AND s.published_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM statutes_master m WHERE m.id = s.published_id)`,
  },
  {
    name: "staging_promoted_case",
    tables: ["scraper_staging", "case_law_master"],
    sql: `SELECT count(*)::bigint FROM scraper_staging s
      WHERE s.promoted = true AND s.promoted_to_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM case_law_master m WHERE m.id = s.promoted_to_id)`,
  },
  {
    name: "staging_promoted_statute",
    tables: ["statutes_staging", "statutes_master"],
    sql: `SELECT count(*)::bigint FROM statutes_staging s
      WHERE s.promoted = true AND s.promoted_to_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM statutes_master m WHERE m.id = s.promoted_to_id)`,
  },
  {
    name: "lifecycle_transition_record",
    tables: ["corpus_lifecycle_transitions", "scraper_staging", "statutes_staging"],
    sql: `SELECT count(*)::bigint FROM corpus_lifecycle_transitions t
      WHERE (t.record_table = 'scraper_staging' AND NOT EXISTS (SELECT 1 FROM scraper_staging s WHERE s.id = t.record_id))
         OR (t.record_table = 'statutes_staging' AND NOT EXISTS (SELECT 1 FROM statutes_staging s WHERE s.id = t.record_id))`,
  },
  {
    name: "decision_published_row",
    tables: ["quarantine_decisions", "case_law_master", "statutes_master"],
    sql: `SELECT count(*)::bigint FROM quarantine_decisions d
      WHERE d.decision = 'promoted' AND d.published_table IS NOT NULL AND d.published_id IS NOT NULL
        AND (
          (d.published_table = 'case_law_master' AND NOT EXISTS (SELECT 1 FROM case_law_master m WHERE m.id = d.published_id))
          OR (d.published_table = 'statutes_master' AND NOT EXISTS (SELECT 1 FROM statutes_master m WHERE m.id = d.published_id))
        )`,
  },
  {
    name: "decision_outbox_row",
    tables: ["quarantine_decisions", "embedding_queue"],
    sql: `SELECT count(*)::bigint FROM quarantine_decisions d
      WHERE d.decision = 'promoted' AND d.embedding_outbox_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM embedding_queue q WHERE q.id = d.embedding_outbox_id)`,
  },
  {
    name: "outbox_record",
    tables: ["embedding_queue", "case_law_master", "statutes_master"],
    sql: `SELECT count(*)::bigint FROM embedding_queue q
      WHERE (q.table_name = 'case_law_master' AND NOT EXISTS (SELECT 1 FROM case_law_master m WHERE m.id = q.record_id))
         OR (q.table_name = 'statutes_master' AND NOT EXISTS (SELECT 1 FROM statutes_master m WHERE m.id = q.record_id))`,
  },
  {
    name: "receipt_queue",
    tables: ["embedding_attempts", "embedding_queue"],
    sql: `SELECT count(*)::bigint FROM embedding_attempts a
      WHERE a.queue_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM embedding_queue q WHERE q.id = a.queue_id)`,
  },
  {
    name: "publication_item_entity",
    tables: ["corpus_publication_item", "judgment", "statute_section_version"],
    sql: `SELECT count(*)::bigint FROM corpus_publication_item i
      WHERE i.decision <> 'rejected' AND i.entity_id IS NOT NULL
        AND (
          (i.entity_type = 'judgment' AND NOT EXISTS (SELECT 1 FROM judgment j WHERE j.id = i.entity_id))
          OR (i.entity_type = 'statute_section_version' AND NOT EXISTS (SELECT 1 FROM statute_section_version v WHERE v.id = i.entity_id))
        )`,
  },
]
