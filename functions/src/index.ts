import { setGlobalOptions } from "firebase-functions/v2"
import { REGION } from "./health"

setGlobalOptions({ region: REGION })

// U-1 (L18 §4.1): the HTTP `api` is the only entry point to the P5 operations — the firm comes
// from X-Firm-Id and every POST carries an Idempotency-Key. There are no onCall callables.
export { health } from "./health"
export { api } from "./http/router"
// P2 job runtime (spec P3-5, P3-8): the creation trigger, the Cloud Tasks worker and the sweeper.
// None is a tenant entry point: they act on job ids from Firestore and Cloud Tasks, not on callers.
export { onJobCreated, onEventCreated, jobWorker, jobSweeper } from "./p2/functions"
// Phase 3c (P3-43): the daily auto-confirm tick, 02:15 Asia/Karachi, one run per firm per day on the P2 engine.
export { d1AutoConfirmTick } from "./p2/functions"
