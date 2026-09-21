import { createHash } from "node:crypto"

/** Firestore document id UTF-8 byte limit (inclusive). */
export const FIRESTORE_DOCUMENT_ID_MAX_UTF8_BYTES = 1500

const WORKFLOW_OPS_HASHED_ID_PREFIX = "woa:"

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/**
 * Stable document id for workflow-ops alert chains. Uses the human-readable
 * `entityKind:parentKey` form when it fits Firestore limits; otherwise hashes the
 * full logical key to a compact `woa:<sha256-hex>` id (68 UTF-8 bytes).
 */
export function buildWorkflowOpsChainedDocumentId(entityKind: string, parentKey: string): string {
  const logical = `${entityKind}:${parentKey}`
  if (utf8ByteLength(logical) <= FIRESTORE_DOCUMENT_ID_MAX_UTF8_BYTES) {
    return logical
  }
  const digest = createHash("sha256").update(logical, "utf8").digest("hex")
  return `${WORKFLOW_OPS_HASHED_ID_PREFIX}${digest}`
}
