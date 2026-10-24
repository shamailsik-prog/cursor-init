import { F02_NEXT_AUTHORITY_ROUTES } from "./f02NextAuthority"
import { createRouter } from "./routerRuntime"

/**
 * The only Functions module Next may load for F02 (FA-F18-013, FA-F18-014).
 * It builds a router over F02_NEXT_AUTHORITY_ROUTES only — not the deployed `api` ROUTES table —
 * so loading this module cannot transitively import p1/ops or the paid transport.
 */
export function createF02Router(): ReturnType<typeof createRouter> {
  return createRouter(F02_NEXT_AUTHORITY_ROUTES)
}
