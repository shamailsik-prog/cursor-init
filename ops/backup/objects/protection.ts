import {
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  PutObjectLockConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type { DocumentVaultConfig, UploadStagingLifecycleConfig } from "../config"

/**
 * The staging expiry a bucket would apply. Not sent by `applyVaultProtection`.
 * S3 lifecycle and the R2 age rule are the same prefix and the same one day.
 * No object lock: the vault's COMPLIANCE retention must not cover this prefix.
 */
export function desiredUploadStagingLifecycle(cfg: UploadStagingLifecycleConfig) {
  const seconds = cfg.expirationDays * 24 * 60 * 60
  return {
    objectLock: cfg.objectLock,
    s3: {
      Rules: [
        {
          ID: cfg.id,
          Status: cfg.status,
          Filter: { Prefix: cfg.prefix },
          Expiration: { Days: cfg.expirationDays },
        },
      ],
    },
    r2: {
      rules: [
        {
          id: cfg.id,
          enabled: cfg.status === "Enabled",
          prefix: cfg.prefix,
          condition: { type: "Age" as const, maxAgeSeconds: seconds },
        },
      ],
    },
  }
}

export function desiredVaultProtection(cfg: DocumentVaultConfig) {
  return {
    objectLockEnabled: true,
    versioning: "Enabled" as const,
    mode: cfg.governanceMode,
    days: cfg.objectLockDays,
  }
}

export async function applyVaultProtection(s3: S3Client, bucket: string, cfg: DocumentVaultConfig): Promise<void> {
  await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }))
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: bucket,
      ObjectLockConfiguration: {
        ObjectLockEnabled: "Enabled",
        Rule: { DefaultRetention: { Mode: cfg.governanceMode, Days: cfg.objectLockDays } },
      },
    })
  )
}

export async function checkVaultProtection(s3: S3Client, bucket: string, cfg: DocumentVaultConfig): Promise<string[]> {
  const problems: string[] = []
  const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))
  if (versioning.Status !== "Enabled") {
    problems.push(`bucket versioning ${versioning.Status ?? "off"} != Enabled`)
  }
  const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }))
  const retention = lock.ObjectLockConfiguration?.Rule?.DefaultRetention
  const days = retention?.Days
  const mode = retention?.Mode
  if (days !== cfg.objectLockDays) problems.push(`object lock days ${days} != ${cfg.objectLockDays}`)
  if (mode !== cfg.governanceMode) problems.push(`object lock mode ${mode} != ${cfg.governanceMode}`)
  return problems
}

export function validateR2LockRules(body: {
  rules?: Array<{ id?: string; enabled?: boolean; prefix?: string; condition?: { type?: string; maxAgeSeconds?: number } }>
}, minAgeSeconds: number): string[] {
  const problems: string[] = []
  const rules = body.rules ?? []
  if (!rules.length) problems.push("rules: missing")
  for (const rule of rules) {
    if (!rule.id) problems.push("rule.id: required")
    if (!rule.enabled) problems.push(`rule ${rule.id}: not enabled`)
    if ((rule.condition?.maxAgeSeconds ?? 0) < minAgeSeconds) problems.push(`rule ${rule.id}: maxAgeSeconds too low`)
    if (!rule.prefix) problems.push(`rule ${rule.id}: prefix required`)
  }
  return problems
}
