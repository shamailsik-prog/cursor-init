export type IdempotentPlan = { action: "restore" | "noop" | "refuse"; reason: string }

/**
 * A second run against an isolated target that already matches counts and checksums is a no-op.
 * A target that exists and was not verified, or that differs, is refused. Nothing is dropped.
 */
export function planIdempotentRestore(input: { targetExists: boolean; contentMatch: boolean | null }): IdempotentPlan {
  if (!input.targetExists) return { action: "restore", reason: "target is absent" }
  if (input.contentMatch === true) return { action: "noop", reason: "target already matches backup counts and checksums" }
  if (input.contentMatch === false) return { action: "refuse", reason: "target exists and content does not match the backup" }
  return { action: "refuse", reason: "target exists and content was not verified" }
}
