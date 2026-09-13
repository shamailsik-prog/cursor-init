import { freshSeededStore } from "@/platform/spine/seed"
import type { SpineStore } from "@/platform/spine/store"

const g = globalThis as typeof globalThis & {
  __sikanderStore?: SpineStore
  __sikanderIdem?: Map<string, { at: number; body: unknown }>
}

export function getStore(): SpineStore {
  if (!g.__sikanderStore) g.__sikanderStore = freshSeededStore()
  return g.__sikanderStore
}

export function resetStore(): SpineStore {
  g.__sikanderStore = freshSeededStore()
  g.__sikanderIdem = new Map()
  return g.__sikanderStore
}

export function remember(key: string, body: unknown): void {
  if (!g.__sikanderIdem) g.__sikanderIdem = new Map()
  g.__sikanderIdem.set(key, { at: Date.now(), body })
}

export function recall(key: string): unknown | undefined {
  const row = g.__sikanderIdem?.get(key)
  if (!row) return undefined
  if (Date.now() - row.at > 24 * 60 * 60 * 1000) return undefined
  return row.body
}
