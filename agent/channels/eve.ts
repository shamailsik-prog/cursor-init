import { eveChannel } from "eve/channels/eve"
import { localDev, vercelOidc } from "eve/channels/auth"

/**
 * Fail closed in production. Phase 0 does not mount this channel on Next.js
 * (`withEve` is not wrapped — that would start an eve server beside the
 * foundation console and skip SIKANDER's classified P1 HTTP path).
 * `eve dev` stays local-only via localDev(). TODO(firm): replace with the
 * firm's session authenticator when the web app has users.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev()],
})
