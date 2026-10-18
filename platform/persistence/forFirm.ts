import {
  CallerFirmRequiredError,
  FirmScopedUpdateError,
  requireCallerFirmId,
} from "@/platform/persistence/callerFirm"
import type { FirmBoundSpineRepositories } from "@/platform/persistence/firmBoundRepositories"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"

function assertUpdateResult<T>(result: T | null, id: string): T {
  if (result === null) {
    throw new FirmScopedUpdateError(`firm-scoped update failed for ${id}`)
  }
  return result
}

/**
 * Binds a caller firm id into repository get/update/list helpers so route code
 * does not repeat firmId on every call while the underlying adapters still enforce it.
 */
export function forFirm(repos: SpineRepositories, firmId: string): FirmBoundSpineRepositories {
  const boundFirmId = requireCallerFirmId(firmId, "bindRouteRepos")

  const bindRepo = (
    repoKey: string,
    repo: Record<string, unknown>
  ): Record<string, unknown> =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== "function") return value
        const name = String(prop)
        if (name === "get") {
          return (first: string, second?: string) => {
            if (repoKey === "members") {
              return (value as (m: string, u: string, f: string) => unknown)(
                first,
                second!,
                boundFirmId
              )
            }
            return (value as (id: string, firm: string) => unknown)(first, boundFirmId)
          }
        }
        if (name === "update") {
          return async (id: string, patch: unknown) =>
            assertUpdateResult(
              await (value as (id: string, firm: string, patch: unknown) => Promise<unknown>)(
                id,
                boundFirmId,
                patch
              ),
              id
            )
        }
        if (name === "setLocked") {
          return (id: string, locked: boolean) =>
            (value as (id: string, firm: string, locked: boolean) => unknown)(
              id,
              boundFirmId,
              locked
            )
        }
        if (name === "getForSessionReplay") {
          return () => {
            throw new Error("getForSessionReplay is not available on firm-bound repositories")
          }
        }
        if (name === "listByFirm") {
          return (_firmId?: string) => (value as (firm: string) => unknown)(boundFirmId)
        }
        if (name.startsWith("listBy") && name !== "listByFirm") {
          return (key: string) =>
            (value as (firm: string, k: string) => unknown)(boundFirmId, key)
        }
        return (value as (...args: unknown[]) => unknown).bind(target)
      },
    })

  const bound = new Proxy(repos, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (value && typeof value === "object") {
        const key = String(prop)
        return bindRepo(key, value as Record<string, unknown>) as FirmBoundSpineRepositories[keyof FirmBoundSpineRepositories]
      }
      return value
    },
  })
  // @ts-expect-error firm-bound Proxy narrows get/update/list method arity
  return bound as FirmBoundSpineRepositories
}

export type { FirmBoundSpineRepositories } from "@/platform/persistence/firmBoundRepositories"

/** Route handlers bind firm once per request; adapters still enforce firmId internally. */
export function bindRouteRepos(repos: SpineRepositories, firmId: string): FirmBoundSpineRepositories {
  if (!firmId?.trim()) {
    throw new CallerFirmRequiredError("bindRouteRepos")
  }
  return forFirm(repos, firmId)
}
