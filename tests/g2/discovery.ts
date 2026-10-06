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
 * - id fields: per action, the declared body fields that reference an object
 *   (`...Id`, `...Ids`, `id`): each must be aimed at firm A or reviewed;
 * - headers: the declared headers.
 */

export type Discovery = {
  selectors: string[]
  params: string[]
  /** Selector key → the id-like body fields that action reads. */
  idFields: Record<string, string[]>
  headers: string[]
}

export const isIdField = (field: string) => field === "id" || /Ids?$/.test(field)

export function discover(route: string, surface: RouteSurface, methods: readonly string[]): Discovery {
  const selectors: string[] = []
  const idFields: Record<string, string[]> = {}
  for (const method of methods) {
    if (method === "GET") {
      if (surface.views.length === 0) selectors.push(`GET ${route} list`)
      for (const view of surface.views) selectors.push(`GET ${route} view=${view}`)
    } else if (method === "POST") {
      for (const action of surface.actions) {
        const ids = surface.bodyFields[action].filter(isIdField)
        const keys =
          action === "whatsapp_command" ? (surface.commands ?? []).map((c) => `POST ${route} command=/${c}`) : [`POST ${route} action=${action}`]
        for (const key of keys) {
          selectors.push(key)
          idFields[key] = ids
        }
      }
    } else {
      selectors.push(`${method} ${route} method`)
    }
  }
  return { selectors: selectors.sort(), params: [...surface.queryParams].sort(), idFields, headers: [...surface.headers] }
}

export type Coverage = {
  listedSelectors: ReadonlySet<string>
  outOfScopeSelectors: ReadonlySet<string>
  attackedParams: ReadonlySet<string>
  reviewedParams: ReadonlySet<string>
  /** Selector key → body fields some aimed attack on it sets. */
  attackedIdFields: ReadonlyMap<string, ReadonlySet<string>>
  reviewedIdFields: ReadonlySet<string>
  reviewedHeaders: ReadonlySet<string>
}

/** Selectors, params, id fields and headers that are neither tested/attacked nor reviewed. */
export function inventoryProblems(route: string, found: Discovery, c: Coverage): string[] {
  const out: string[] = []
  for (const s of found.selectors) if (!c.listedSelectors.has(s)) out.push(`unlisted selector: ${s}`)
  for (const p of found.params) if (!c.attackedParams.has(p) && !c.reviewedParams.has(p)) out.push(`${route}: param "${p}" is neither attacked nor reviewed`)
  for (const [selector, fields] of Object.entries(found.idFields)) {
    if (c.outOfScopeSelectors.has(selector)) continue
    const attacked = c.attackedIdFields.get(selector) ?? new Set<string>()
    for (const f of fields) if (!attacked.has(f) && !c.reviewedIdFields.has(f)) out.push(`${selector}: id field "${f}" is neither aimed at firm A nor reviewed`)
  }
  for (const h of found.headers) if (!c.reviewedHeaders.has(h)) out.push(`${route}: header "${h}" is not reviewed`)
  return out
}
