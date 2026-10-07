import { setGlobalOptions } from "firebase-functions/v2"
import { REGION } from "./health"

setGlobalOptions({ region: REGION })

// U-1 (L18 §4.1): the HTTP `api` is the only entry point to the P5 operations — the firm comes
// from X-Firm-Id and every POST carries an Idempotency-Key. There are no onCall callables.
export { health } from "./health"
export { api } from "./http/router"
