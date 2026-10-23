import type { HandlerSession, RouteHandler } from "@/platform/http/withSession"
import { presentingBearer } from "@/platform/http/surface"
import { mustDispatchF02 } from "@/platform/authority/f02Mode"
import { registerF02Core, type F02Session } from "@/platform/authority/f02Registry"
import type { F02Method, F02RoutePath } from "@/platform/authority/f02Routes"

/**
 * Registers `core` for the in-process Functions operation and, on the production
 * Firestore path, dispatches a bearer request through that router. A call with no
 * bearer stays on the Next handler: firebase auth mode never reaches here without
 * one (withSession already refused it), and the insecure-dev emulator suites keep
 * their body-actor contract. The dynamic import keeps firebase-functions off the
 * module graph of unit tests and of memory-mode boot.
 */
export function withF02Authority(path: F02RoutePath, method: F02Method, core: RouteHandler): RouteHandler {
  registerF02Core(path, method, (request, session) => core(request, session as HandlerSession | null))
  return async (request, session) => {
    if (!mustDispatchF02() || !presentingBearer(request)) return core(request, session)
    const { dispatchF02 } = await import("@/platform/authority/dispatchF02")
    return dispatchF02(request, path, method, session as F02Session)
  }
}
