"""Publication of harvested and curated authority into the Annex A corpus contract (audit F19).

This package is the only code in corpus_service that writes the Annex A tables
(postgres/ddl/001_corpus_contract.sql, 003_corpus_publication.sql). Every write happens inside an
audited, idempotent corpus publication (annex_a.publish_batch).
"""
