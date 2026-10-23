import type { HandlerSession, RouteHandler } from "@/platform/http/withSession"
import { errorResponse } from "@/platform/http/errors"
import { presentingBearer } from "@/platform/http/surface"
import { mustDispatchF02 } from "@/platform/authority/f02Mode"
import { registerF02Core, type F02Session } from "@/platform/authority/f02Registry"
import type { F02Method, F02RoutePath } from "@/platform/authority/f02Routes"
import { AuthError, resolveAuthMode } from "@/platform/p5/session"

/**
 * Registers `core` for the in-process Functions operation and, on the production
 * Firestore path, dispatches a bearer request through that router.
 *
 * A call with no bearer does not skip checkPermission for a privileged write:
 * - firebase mode (the default, and the only mode a production process can run)
 *   returns 401 before the core. withSession already does this; the gate does
 *   too, so reaching the handler without a bearer still cannot write.
 * - insecure-dev stays on the Next handler so the local body-actor suites keep
 *   their contract. resolveAuthMode rejects that mode unless NODE_ENV is
 *   development or test, and rejects it on every hosted runtime. A mis-set
 *   insecure-dev in production or on Cloud Run returns 503 and does not write.
 *
 * The dynamic import keeps firebase-functions off the module graph of unit
 * tests and of memory-mode boot.
 */
export function withF02Authority(path: F02RoutePath, method: F02Method, core: RouteHandler): RouteHandler {
  registerF02Core(path, method, (request, session) => core(request, session as HandlerSession | null))
  return async (request, session) => {
    if (!mustDispatchF02()) return core(request, session)
    if (!presentingBearer(request)) return bearerless(request, session, core)
    const { dispatchF02 } = await import("@/platform/authority/dispatchF02")
    return dispatchF02(request, path, method, session as F02Session)
  }
}

async function bearerless(request: Request, session: HandlerSession | null, core: RouteHandler): Promise<Response> {
  try {
    if (resolveAuthMode() === "insecure-dev") return core(request, session)
  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(err.status, err.code, err.status >= 500 ? "auth not configured" : err.message)
    }
    throw err
  }
  return errorResponse(401, "AUTH_REQUIRED", "authentication required")
}
