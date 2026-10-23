import { createRouter, ROUTES } from "./router"

/**
 * The only Functions module Next may load for F02 (FA-F18-013).
 * It builds the deployed `api` router. It does not re-export ROUTES, createRouter, or any p1 module,
 * so a Next file cannot name those by importing this boundary.
 */
export function createF02Router(): ReturnType<typeof createRouter> {
  return createRouter(ROUTES)
}
