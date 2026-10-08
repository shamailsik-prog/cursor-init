import { FieldValue } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { FirmOperation } from "../../p5/common"
import { requirePermission } from "../../p5/permission"
import { PREFIX_PATTERN } from "../numbering"

function parsePrefix(value: unknown): string {
  if (typeof value !== "string" || !PREFIX_PATTERN.test(value)) throw new HttpError(400, "invalid_prefix")
  return value
}

/**
 * setFirmNumbering({ clientPrefix, matterPrefix }) → { firmId, clientPrefix, matterPrefix }.
 * Partner only (firm.set_numbering). Merges the two prefixes (2-6 capital letters) into
 * `firms/{firmId}` and touches no other field.
 */
export const setFirmNumberingOp: FirmOperation<{ firmId: string; clientPrefix: string; matterPrefix: string }> = {
  auth: "firm",
  kind: "general",
  action: "firm.set_numbering",
  target: "firms",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "firm.set_numbering")
    const clientPrefix = parsePrefix(data.clientPrefix)
    const matterPrefix = parsePrefix(data.matterPrefix)

    const firmRef = adminDb().collection("firms").doc(caller.firmId)
    await adminDb().runTransaction(async (tx) => {
      if (!(await tx.get(firmRef)).exists) throw new HttpError(404, "not_found")
      await audit.stage(tx, "allow", "ok")
      tx.update(firmRef, { clientPrefix, matterPrefix, updatedAt: FieldValue.serverTimestamp() })
    })
    audit.committed()
    return { firmId: caller.firmId, clientPrefix, matterPrefix }
  },
}
