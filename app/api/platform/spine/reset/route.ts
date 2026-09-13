import { withIdempotency } from "@/platform/http/respond"
import { resetStore } from "@/platform/spine/session"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    resetStore()
    return { reset: true }
  })
}
