import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { logFailure } from "../../log"
import { l17_2Enabled } from "../conflict/engine"

/**
 * The L17.2 layer gate of the entity routes (spec P2-31): with `L17_2_ENABLED` off for the firm
 * every `/api/d1/entity/*` route answers 404 feature_disabled (a disabled layer exposes no
 * functions). Checked after the permission check. An unreadable firm doc fails toward off, as the
 * conflict engine reads it (l17_2Enabled).
 */
export async function requireL17_2(firmId: string): Promise<void> {
  const firm = await adminDb()
    .collection("firms")
    .doc(firmId)
    .get()
    .then((s) => ({ ok: true as const, data: s.data() }))
    .catch((err: unknown) => {
      logFailure("entity flag read failed", err)
      return { ok: false as const, data: undefined }
    })
  if (!l17_2Enabled(firm.data, firm.ok)) throw new HttpError(404, "feature_disabled")
}
