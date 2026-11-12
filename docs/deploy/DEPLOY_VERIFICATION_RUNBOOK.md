# Deploy verification runbook (read-only)

Live steps are **NOT DEMONSTRATED**. Placeholders only: `<PROJECT_ID>`, `<PROFILE>`, `<SNAPSHOT_DIR>`, `<READER_DSN_FROM_SECRET_STORE>`, `<REGION>`, `<name>`, `<runtime SA>`, `<SHA>`, `<SECTION_ID>`, `<DATE_1>`, `<DATE_2>`, `<ACT_SHORT_NAME>`.

## §0 Rules

- Read-only only.
- STOP on the first mismatch or error, record it, and fix nothing in place.
- Never paste secrets into the record.
- The operator runs it. An independent reviewer (the Master Engineer) signs the archived output. The builder never runs it.

## §A FA-F32-R124-001 snapshot and drift report

Run this from the exact commit being deployed, and save its output as `<SNAPSHOT_DIR>/provenance.txt`:

```bash
bash scripts/deploy-preflight.sh --profile <PROFILE> --project-id <PROJECT_ID>
```

Capture only these read commands. Each uses `--format=json`. Write each response into the layout below and nothing else.

```bash
gcloud functions list --project=<PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/functions-list.json`.

For every manifest function, describe that function and save the response as `<SNAPSHOT_DIR>/functions/<name>.json`:

```bash
gcloud functions describe <name> --gen2 --region <region> --project=<PROJECT_ID> --format=json
```

```bash
gcloud projects get-iam-policy <PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/iam-policy.json`.

```bash
gcloud iam service-accounts get-iam-policy "<runtime SA>" --project=<PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/runtime-sa-iam-policy.json`.

```bash
gcloud tasks queues list --location <region> --project=<PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/queues-list.json`.

For the jobWorker queue (each manifest `queues[].function`, file `queue-<function>.json`):

```bash
gcloud tasks queues describe jobWorker --location <region> --project=<PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/queue-jobWorker.json`.

```bash
gcloud services list --enabled --project=<PROJECT_ID> --format=json
```

Save that as `<SNAPSHOT_DIR>/services-enabled.json`.

Then run:

```bash
python3 ci_gates/check_deploy_drift.py --profile <PROFILE> --snapshot <SNAPSHOT_DIR>
```

Archive the full stdout and the sha256 of every snapshot file. Exit 0 is required. Any FAIL is a STOP.

## §B Corpus DB Annex A / FA-DATA-002 guard

Use a non-superuser reader login that is a member of `corpus_authority_reader` (and of `corpus_clients` only where CONNECT requires it). Never use the bootstrap superuser. Take the DSN from the secret store as `<READER_DSN_FROM_SECRET_STORE>`. Do not paste the DSN into the record.

Open the session with that login, then run this block. Expected results, in order: `15`; `t`; `O`; `0`; `0`. A permission error is a mismatch: STOP, record it, and fix nothing in place.

```sql
SET default_transaction_read_only = on;
BEGIN READ ONLY;
SELECT count(*) FROM public.corpus_contract_routines();
SELECT to_regprocedure('public.enforce_embedding_classification()') IS NOT NULL;
SELECT t.tgenabled
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'corpus_embeddings'
   AND t.tgname = 'corpus_embeddings_monotonic'
   AND NOT t.tgisinternal;
SELECT (
    SELECT count(*)
      FROM public.corpus_contract_relations() r
      JOIN pg_catalog.pg_class c ON c.oid = r
      JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
     WHERE NOT o.rolsuper
  ) + (
    SELECT count(*)
      FROM public.corpus_contract_routines() f
      JOIN pg_catalog.pg_proc p ON p.oid = f.routine
      JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
     WHERE NOT o.rolsuper
  );
SELECT count(*)
  FROM public.corpus_contract_routines() f
  CROSS JOIN (VALUES ('<APP_DB_ROLE>'), ('<MIGRATE_DB_ROLE>'), ('corpus_clients'), ('public')) u(n)
 WHERE NOT f.public_execute
   AND has_function_privilege(u.n, f.routine, 'EXECUTE');
ROLLBACK;
```

The privilege query mirrors the Annex A routine check: `has_function_privilege` is false for the runtime app role and PUBLIC (and for the migration role and `corpus_clients`) on routines the DDL keeps from PUBLIC.

## §C P5 Q04 change (provenance only)

Record the Functions deploy commit from the `commit:` line in `<SNAPSHOT_DIR>/provenance.txt`. Record the Vercel production deployment's commit from the Vercel UI or from `vercel inspect` (read-only). Both commits must be descendants of 6f7dea3:

```bash
git merge-base --is-ancestor 6f7dea3 <SHA>
```

Behavioural runtime of `decide()` stays UNVERIFIED. There is no mutating probe.

## §D Q03-RUNTIME-489F (BLOCKED template)

**BLOCKED until a curated Annex A history batch for s.489-F exists.** Do not run before then. This template has no statute wording.

Use the same `corpus_authority_reader` login as §B. `<SECTION_ID>` is the identifier the curated batch supplies for PPC s.489-F. The two dates are `<DATE_1>` and `<DATE_2>`. The query reads version identity and effective dates only.

```sql
SET default_transaction_read_only = on;
BEGIN READ ONLY;
SELECT section_id, version_no, effective_from, effective_to, version_confidence
  FROM public.v_authority_section_version
 WHERE section_id = '<SECTION_ID>'::uuid
   AND effective_from <= DATE '<DATE_1>'
   AND (effective_to IS NULL OR effective_to > DATE '<DATE_1>')
UNION ALL
SELECT section_id, version_no, effective_from, effective_to, version_confidence
  FROM public.v_authority_section_version
 WHERE section_id = '<SECTION_ID>'::uuid
   AND effective_from <= DATE '<DATE_2>'
   AND (effective_to IS NULL OR effective_to > DATE '<DATE_2>');
ROLLBACK;
```

## §E DATA003-OPS-001 (export template)

Read-only export of the affected acts' `statutes_master` and `statutes_staging` rows. Use a non-superuser login that can read those two tables. Never use the bootstrap superuser. The output goes to the Master Engineer for the offline planner. No apply. Any apply needs its own go-ahead.

```sql
SET default_transaction_read_only = on;
BEGIN READ ONLY;
\copy (SELECT id, short_name, section_number, statute_name, section_title, section_text, is_repealed, harvest_at, year_enacted, effective_date, source_site FROM public.statutes_master WHERE short_name = '<ACT_SHORT_NAME>') TO '<SNAPSHOT_DIR>/statutes_master.copy' WITH (FORMAT csv, HEADER true)
\copy (SELECT id, extracted_short_name, extracted_section_number, extracted_act_name, extracted_section_title, extracted_section_text, lifecycle_state, published_id, source_site FROM public.statutes_staging WHERE extracted_short_name = '<ACT_SHORT_NAME>') TO '<SNAPSHOT_DIR>/statutes_staging.copy' WITH (FORMAT csv, HEADER true)
ROLLBACK;
```
