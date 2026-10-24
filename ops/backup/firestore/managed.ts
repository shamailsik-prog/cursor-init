import type { FirestoreBackupConfig } from "../config"

export type FirestoreCommandCtx = { project: string; location: string; exportBucket: string }

export function firestoreCommands(cfg: FirestoreBackupConfig, ctx: FirestoreCommandCtx): Record<string, string[]> {
  const db = cfg.database
  const out: Record<string, string[]> = {
    enablePitr: ["gcloud", "firestore", "databases", "update", `--database=${db}`, "--enable-pitr"],
    schedule: [
      "gcloud",
      "firestore",
      "backups",
      "schedules",
      "create",
      `--database=${db}`,
      `--recurrence=${cfg.schedule.recurrence}`,
      `--retention=${cfg.schedule.retention}`,
    ],
    export: ["gcloud", "firestore", "export", `gs://${ctx.exportBucket}/${new Date().toISOString()}`, `--database=${db}`],
    bucketCreate: ["gcloud", "storage", "buckets", "create", `gs://${ctx.exportBucket}`, "--uniform-bucket-level-access"],
    bucketRetention: [
      "gcloud",
      "storage",
      "buckets",
      "update",
      `gs://${ctx.exportBucket}`,
      `--retention-period=${cfg.exportBucket.retentionDays}d`,
    ],
    restoreBackup: [
      "gcloud",
      "firestore",
      "databases",
      "restore",
      `--source-backup=projects/${ctx.project}/locations/${ctx.location}/backups/BACKUP_ID`,
      `--destination-database=${cfg.restore.destinationDatabase}`,
    ],
    clonePitr: [
      "gcloud",
      "firestore",
      "databases",
      "clone",
      `--source-database=projects/${ctx.project}/databases/${db}`,
      `--snapshot-time=${cfg.restore.snapshotTime}`,
      `--destination-database=${cfg.restore.destinationDatabase}`,
    ],
    importExport: [
      "gcloud",
      "firestore",
      "import",
      `gs://${ctx.exportBucket}/PREFIX/`,
      `--database=${cfg.restore.destinationDatabase}`,
    ],
  }
  if (cfg.exportBucket.lock) {
    out.bucketLock = ["gcloud", "storage", "buckets", "update", `gs://${ctx.exportBucket}`, "--lock-retention-period"]
  }
  return out
}
