// A leaf module: it imports nothing, so auth.ts, common.ts and router.ts can all share it without an import cycle.

/** Request headers as Node / express deliver them (lower-case names; a repeated header may be an array). */
export type Headers = Record<string, string | string[] | undefined>

/** A header's value by case-insensitive name; the first value of a repeated header. */
export function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}
