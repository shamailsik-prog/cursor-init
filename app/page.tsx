import { ConsoleAuthBanner } from "@/app/console-auth-banner"
import { ConsoleAuthProvider } from "@/app/console-auth-provider"
import { FoundationConsole } from "@/app/foundation-console"
import { getCourts, getDocumentTypes, getFixtures } from "@/lib/foundation-data"

export default function Page() {
  return (
    <ConsoleAuthProvider>
      <ConsoleAuthBanner />
      <FoundationConsole
        courts={getCourts()}
        fixtures={getFixtures()}
        types={getDocumentTypes()}
      />
    </ConsoleAuthProvider>
  )
}
