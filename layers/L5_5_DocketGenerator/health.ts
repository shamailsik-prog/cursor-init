import { DOCKET_GENERATOR_FLAG, isDocketGeneratorEnabled } from "@/layers/L5_5_DocketGenerator/flag"

export function healthCheck(): { ok: true; flag: typeof DOCKET_GENERATOR_FLAG; enabled: boolean } {
  return { ok: true, flag: DOCKET_GENERATOR_FLAG, enabled: isDocketGeneratorEnabled() }
}

/** No event subscriptions and no stored rows. Disabling leaves nothing to delete. */
export function disable(): { unsubscribed: true; dataIntact: true } {
  return { unsubscribed: true, dataIntact: true }
}
