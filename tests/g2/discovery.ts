import type { RouteSurface } from "@/platform/http/surface"

/**
 * Gate G-2 inventory: what a caller can select in a G-2 route, read from the
 * route's declared surface (app/api/<route>/surface.ts) and its exported
 * methods. The route can only dispatch through that surface: the helpers
 * refuse undeclared keys at runtime, and tests/g2.surface-guard.test.ts fails
 * any selector read that bypasses them. So the surface is the inventory.
 *
 * - GET: one selector per declared view (`list` when it has none);
 * - POST: one per declared action (WhatsApp: one per declared command);
 * - any other exported method: its own selector;
 * - params: the declared query params;
 * - body fields: per action, every declared body field: each must be set to a
 *   firm-A value by an aimed attack, or reviewed as a non-selector;
 * - headers: the declared headers.
 */

export type Discovery = {
  selectors: string[]
  params: string[]
  /** Selector key → the body fields that action reads. */
  bodyFields: Record<string, string[]>
  headers: string[]
}

export function discover(route: string, surface: RouteSurface, methods: readonly string[]): Discovery {
  const selectors: string[] = []
  const bodyFields: Record<string, string[]> = {}
  for (const method of methods) {
    if (method === "GET") {
      if (surface.views.length === 0) selectors.push(`GET ${route} list`)
      for (const view of surface.views) selectors.push(`GET ${route} view=${view}`)
    } else if (method === "POST") {
      for (const action of surface.actions) {
        const fields = [...surface.bodyFields[action]]
        const keys =
          action === "whatsapp_command" ? (surface.commands ?? []).map((c) => `POST ${route} command=/${c}`) : [`POST ${route} action=${action}`]
        for (const key of keys) {
          selectors.push(key)
          bodyFields[key] = fields
        }
      }
    } else {
      selectors.push(`${method} ${route} method`)
    }
  }
  return { selectors: selectors.sort(), params: [...surface.queryParams].sort(), bodyFields, headers: [...surface.headers] }
}

export type Coverage = {
  listedSelectors: ReadonlySet<string>
  outOfScopeSelectors: ReadonlySet<string>
  attackedParams: ReadonlySet<string>
  reviewedParams: ReadonlySet<string>
  /** Selector key → body fields some aimed attack on it sets to a firm-A value. */
  attackedBodyFields: ReadonlyMap<string, ReadonlySet<string>>
  reviewedBodyFields: ReadonlySet<string>
  reviewedHeaders: ReadonlySet<string>
}

/** Selectors, params, body fields and headers that are neither tested/attacked nor reviewed. */
export function inventoryProblems(route: string, found: Discovery, c: Coverage): string[] {
  const out: string[] = []
  for (const s of found.selectors) if (!c.listedSelectors.has(s)) out.push(`unlisted selector: ${s}`)
  for (const p of found.params) if (!c.attackedParams.has(p) && !c.reviewedParams.has(p)) out.push(`${route}: param "${p}" is neither attacked nor reviewed`)
  for (const [selector, fields] of Object.entries(found.bodyFields)) {
    if (c.outOfScopeSelectors.has(selector)) continue
    const attacked = c.attackedBodyFields.get(selector) ?? new Set<string>()
    for (const f of fields) if (!attacked.has(f) && !c.reviewedBodyFields.has(f)) out.push(`${selector}: body field "${f}" is neither aimed at firm A nor reviewed`)
  }
  for (const h of found.headers) if (!c.reviewedHeaders.has(h)) out.push(`${route}: header "${h}" is not reviewed`)
  return out
}
