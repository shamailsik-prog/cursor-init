import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Cores registered by the Next route modules. The deployed Functions process does
 * not load `app/api`, so a direct hit returns 503 `authority_core_unconfigured`.
 * Next is the HTTP front door and runs the router in-process with a core registered.
 */
export type F02Session = {
  userId: string
  firmId: string
  role: string
  clearance: string
  mode: "firebase" | "insecure-dev"
} | null

export type F02Core = (request: Request, session: F02Session) => Promise<Response> | Response

const cores = new Map<string, F02Core>()
const pending = new AsyncLocalStorage<{ request: Request; session: F02Session }>()
const frame = new AsyncLocalStorage<true>()
let coreCalls = 0

function key(method: string, path: string): string {
  return `${method} ${path}`
}

export function registerF02Core(path: string, method: string, core: F02Core): void {
  cores.set(key(method, path), core)
}

/** Puts the core map back. A test that installs a stand-in core must restore the real one. */
export function snapshotF02CoresForTests(): () => void {
  const saved = new Map(cores)
  return () => {
    cores.clear()
    for (const [k, v] of saved) cores.set(k, v)
  }
}

export function inAuthorityFrame(): boolean {
  return frame.getStore() === true
}

export function runInAuthorityFrame<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(frame.run(true, fn))
}

export function runWithF02Pending<T>(
  request: Request,
  session: F02Session,
  fn: () => Promise<T>
): Promise<T> {
  return pending.run({ request, session }, fn)
}

/** How many times a registered core was entered. A clearance denial does not increment this. */
export function f02CoreCallCount(): number {
  return coreCalls
}

export function resetF02CoreCallsForTests(): void {
  coreCalls = 0
}

export async function invokeF02Core(path: string, method: string): Promise<Response> {
  const core = cores.get(key(method, path))
  const ctx = pending.getStore()
  if (!core || !ctx) throw new Error("authority_core_unconfigured")
  coreCalls += 1
  return runInAuthorityFrame(() => core(ctx.request, ctx.session))
}
