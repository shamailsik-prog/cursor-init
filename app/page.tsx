import { FoundationConsole } from "@/app/foundation-console"
import { getCourts, getDocumentTypes, getFixtures } from "@/lib/foundation-data"

export default function Page() {
  return (
    <FoundationConsole
      courts={getCourts()}
      fixtures={getFixtures()}
      types={getDocumentTypes()}
    />
  )
}
