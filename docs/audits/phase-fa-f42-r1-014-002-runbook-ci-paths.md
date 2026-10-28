# FA-F42-R1-014-002 — Backup drill workflow paths for runbook edits

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014-002** [LOW]

## Problem

`backup-drill.yml` PR/push `paths:` filters did not include `docs/runbooks/**`. A PR that only edited or deleted restore prose in `docs/runbooks/backup-restore.md` would skip the workflow, so `ops/backup/test/runbook-f42-restore.unit.test.ts` would not run until weekly cron or manual dispatch.

## Correction

- Add `docs/runbooks/**` to `pull_request.paths` and `push.paths` in `.github/workflows/backup-drill.yml` (existing paths unchanged).
- No change to F42 restore guard pins in `runbook-f42-restore.unit.test.ts`.

## Verification

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/backup-drill.yml'))"
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/runbook-f42-restore.unit.test.ts
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (CI path coverage only; live restore drill NOT DEMONSTRATED) |
| scope | FA-F42-R1-014-002 only |
