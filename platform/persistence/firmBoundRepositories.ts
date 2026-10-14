import type { SpineRepositories } from "@/platform/persistence/spineRepositories"

type BoundGet<F extends (...args: unknown[]) => unknown> = Parameters<F>["length"] extends 3
  ? F extends (a: string, b: string, c: string) => Promise<infer T>
    ? (a: string, b: string) => Promise<T>
    : F
  : F extends (id: string, firmId: string) => Promise<infer T>
    ? (id: string) => Promise<T>
    : F

type BoundUpdate<F> = F extends (
  id: string,
  firmId: string,
  patch: infer P
) => Promise<infer T>
  ? (id: string, patch: P) => Promise<T>
  : F

type BoundSetLocked<F> = F extends (
  id: string,
  firmId: string,
  locked: boolean
) => Promise<infer T>
  ? (id: string, locked: boolean) => Promise<T>
  : F

type BoundListByFirm<F> = F extends (firmId: string) => Promise<infer T>
  ? (firmId?: string) => Promise<T>
  : F

type BoundListByField<F> = F extends (
  firmId: string,
  key: string
) => Promise<infer T>
  ? (key: string) => Promise<T>
  : F

type BoundRepo<R> = {
  [K in keyof R]: K extends "get"
    ? BoundGet<Extract<R[K], (...args: any) => any>>
    : K extends "update"
      ? BoundUpdate<R[K]>
      : K extends "setLocked"
        ? BoundSetLocked<R[K]>
        : K extends "listByFirm"
          ? BoundListByFirm<R[K]>
          : K extends `listBy${string}`
            ? BoundListByField<R[K]>
            : R[K]
}

/** Repository surface after binding a single request firm (single-arg get/update/list). */
export type FirmBoundSpineRepositories = {
  [K in keyof SpineRepositories]: BoundRepo<SpineRepositories[K]>
}
