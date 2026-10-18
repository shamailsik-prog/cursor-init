import net from "node:net"

/**
 * Audit F18 re-audit follow-up: a process-wide network tripwire for every test file that could reach an AI transport.
 * Installed at import time of the test file (before any suite runs), it refuses and records:
 *   - every `fetch` to a host that is not loopback, or to the agent proxy's port;
 *   - every socket connect (net, tls, http, http2, gRPC all go through `net.Socket.prototype.connect`) to a host that is
 *     not loopback, or to the agent proxy's port. An IPC socket counts only when its `path` is a non-empty string: the
 *     HTTP and TLS agents pass `path: null`, which a first version of the auditor's tripwire let through.
 * The proxy's port is read from the proxy variables at each connect: a loopback proxy forwards to the internet, so
 * "loopback" alone is not "local".
 *
 * Refusals never reach the network: a refused fetch throws, a refused socket is destroyed on the next tick before any
 * connect. Nothing here names a provider; tests use `.invalid` hosts (RFC 2606), which never resolve.
 */

export type NetworkTripwire = { refused: string[]; uninstall: () => void }

type Installed = NetworkTripwire & { depth: number }
const STATE = Symbol.for("sikander.f18.networkTripwire")
const holder = globalThis as unknown as { [STATE]?: Installed }

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

export function isLoopbackHost(hostRaw: unknown): boolean {
  const h = String(hostRaw ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Ports of the proxies the environment names (any host): a connection to one of them on loopback reaches the internet. */
export function proxyPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const ports = new Set<number>()
  for (const name of PROXY_VARS) {
    const raw = env[name]?.trim()
    if (!raw) continue
    try {
      const url = new URL(raw.includes("://") ? raw : `http://${raw}`)
      ports.add(Number(url.port || (url.protocol === "https:" ? 443 : 80)))
    } catch {
      // an unparsable proxy value names no port
    }
  }
  return ports
}

type Target = { host: string | undefined; port: number | undefined; ipc: boolean }

function targetOf(args: unknown[]): Target {
  let first: unknown = args[0]
  if (Array.isArray(first)) first = first[0]
  if (first !== null && typeof first === "object") {
    const o = first as { host?: unknown; port?: unknown; path?: unknown }
    const ipc = typeof o.path === "string" && o.path !== ""
    const port = o.port === undefined || o.port === null ? undefined : Number(o.port)
    return { host: typeof o.host === "string" ? o.host : undefined, port, ipc }
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { host: typeof args[1] === "string" ? args[1] : undefined, port: Number(first), ipc: false }
  }
  if (typeof first === "string") return { host: undefined, port: undefined, ipc: true }
  return { host: undefined, port: undefined, ipc: false }
}

function refuses(host: unknown, port: number | undefined): boolean {
  return !isLoopbackHost(host) || (port !== undefined && proxyPorts().has(port))
}

/** Installs the tripwire (idempotent within a process: nested installs share one record). */
export function installNetworkTripwire(): NetworkTripwire {
  const existing = holder[STATE]
  if (existing) {
    existing.depth += 1
    return existing
  }
  const refused: string[] = []
  const realFetch = globalThis.fetch
  const realConnect = net.Socket.prototype.connect

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    if (refuses(url.hostname, port)) {
      refused.push(`fetch:${url.host}`)
      throw new TypeError(`network tripwire: fetch to ${url.host} refused`)
    }
    return realFetch(input, init)
  }) as typeof fetch

  net.Socket.prototype.connect = function tripwireConnect(this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args)
    if (!t.ipc && refuses(t.host, t.port)) {
      refused.push(`socket:${t.host ?? "localhost"}:${t.port ?? ""}`)
      const err = new Error(`network tripwire: socket to ${t.host}:${t.port} refused`)
      process.nextTick(() => this.destroy(err))
      return this
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect

  const installed: Installed = {
    refused,
    depth: 1,
    uninstall() {
      installed.depth -= 1
      if (installed.depth > 0) return
      globalThis.fetch = realFetch
      net.Socket.prototype.connect = realConnect
      delete holder[STATE]
    },
  }
  holder[STATE] = installed
  return installed
}
