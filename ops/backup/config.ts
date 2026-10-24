import { readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

const policySchema = z.object({
  stores: z.record(
    z.object({
      rpo: z.string(),
      rtoTargetMinutes: z.number().int().positive(),
      ownerRole: z.string(),
      deputyRole: z.string(),
      schedule: z.string(),
    })
  ),
})

const postgresBackupSchema = z.object({
  walLevel: z.literal("replica"),
  archiveMode: z.literal("on"),
  archiveTimeoutSeconds: z.number().int().positive(),
  archiveCommandTemplate: z.string(),
  baseBackupRetentionDays: z.number().int().positive(),
})

const firestoreBackupSchema = z.object({
  database: z.string(),
  schedule: z.object({ recurrence: z.string(), retention: z.string() }),
  exportBucket: z.object({ retentionDays: z.number().int().positive(), lock: z.boolean().optional() }),
  restore: z.object({
    destinationDatabase: z.string().refine((d) => d !== "(default)", "must not restore into (default)"),
    snapshotTime: z.string().optional(),
  }),
})

const documentVaultSchema = z.object({
  objectLockDays: z.number().int().positive(),
  governanceMode: z.literal("GOVERNANCE"),
  r2LockMinAgeSeconds: z.number().int().positive(),
})

export type BackupPolicy = z.infer<typeof policySchema>
export type PostgresBackupConfig = z.infer<typeof postgresBackupSchema>
export type FirestoreBackupConfig = z.infer<typeof firestoreBackupSchema>
export type DocumentVaultConfig = z.infer<typeof documentVaultSchema>

export type InfraBackupConfig = {
  policy: BackupPolicy
  postgres: PostgresBackupConfig
  firestore: FirestoreBackupConfig
  documentVault: DocumentVaultConfig
}

export function loadInfraConfig(root: string): InfraBackupConfig {
  const base = path.join(root, "infra", "backup")
  const read = (name: string) => JSON.parse(readFileSync(path.join(base, name), "utf8"))
  return {
    policy: policySchema.parse(read("policy.json")),
    postgres: postgresBackupSchema.parse(read("postgres-backup.json")),
    firestore: firestoreBackupSchema.parse(read("firestore-backup.json")),
    documentVault: documentVaultSchema.parse(read("document-vault.json")),
  }
}
