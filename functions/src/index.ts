import { setGlobalOptions } from "firebase-functions/v2"
import { REGION } from "./health"

setGlobalOptions({ region: REGION })

export { health } from "./health"
export { onboardFirm, createFirmUser, setUserClaims, deactivateUser } from "./p5/identity"
export { enforceMfaForRole, generateRecoveryCodes, approveMfaDisable, disableMfa } from "./p5/mfa"
