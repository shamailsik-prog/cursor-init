import type { HandlerSession, RouteHandler } from "@/platform/http/withSession"
import { mustDispatchF02 } from "@/platform/authority/f02Mode"
import { registerF02Core, type F02Session } from "@/platform/authority/f02Registry"
import type { F02Method, F02RoutePath } from "@/platform/authority/f02Routes"

/**
 * Registers `core` for the in-process Functions operation and, on the production
 * Firestore path, dispatches the already-authenticated request through that router.
 * The dynamic import keeps firebase-functions off the module graph of unit tests
 * and of memory-mode boot.
 */
export function withF02Authority(path: F02RoutePath, method: F02Method, core: RouteHandler): RouteHandler {
  registerF02Core(path, method, (request, session) => core(request, session as HandlerSession | null))
  return async (request, session) => {
    if (!mustDispatchF02()) return core(request, session)
    const { dispatchF02 } = await import("@/platform/authority/dispatchF02")
    return dispatchF02(request, path, method, session as F02Session)
  }
}
