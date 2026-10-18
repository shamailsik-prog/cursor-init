import http from "node:http"
import net from "node:net"
import tls from "node:tls"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { installNetworkTripwire, isLoopbackHost, proxyPorts, type NetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F18 re-audit follow-up (brief: "check yours refuses fetch, raw sockets and the proxy port before any suite runs"):
 * the tripwire the F18 test files install refuses every non-loopback fetch and socket, the socket form the HTTP and TLS
 * agents use (`path: null`), and the local agent proxy's port, while loopback (the emulators, the in-process Functions
 * router) still works. Every target is an RFC 2606 `.invalid` host, which never resolves: even a broken tripwire could
 * not reach anything.
 */

const tripwire: NetworkTripwire = installNetworkTripwire()

let local: http.Server
let localPort = 0
let localHits = 0

beforeAll(async () => {
  local = http.createServer((_req, res) => {
    localHits += 1
    res.end("ok")
  })
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve))
  localPort = (local.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => local.close(() => resolve()))
  tripwire.uninstall()
})

afterEach(() => {
  tripwire.refused.length = 0
  vi.unstubAllEnvs()
})

function socketOutcome(socket: net.Socket): Promise<"connected" | string> {
  return new Promise((resolve) => {
    socket.once("connect", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("secureConnect", () => {
      socket.destroy()
      resolve("connected")
    })
    socket.once("error", (err: Error) => resolve(err.message))
  })
}

describe("audit F18 follow-up: the network tripwire", () => {
  it("knows loopback from everything else", () => {
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", undefined]) expect(isLoopbackHost(host), String(host)).toBe(true)
    for (const host of ["10.0.0.1", "192.168.1.1", "0.0.0.0", "provider.example.invalid", "127.0.0.1.example.invalid"]) expect(isLoopbackHost(host), host).toBe(false)
  })

  it("reads the proxy's port from the proxy variables", () => {
    expect([...proxyPorts({ HTTPS_PROXY: "http://127.0.0.1:39173" })]).toEqual([39173])
    expect([...proxyPorts({ http_proxy: "127.0.0.1:3128" })]).toEqual([3128])
    expect([...proxyPorts({})]).toEqual([])
  })

  it("refuses a fetch to a non-loopback host", async () => {
    await expect(fetch("https://gateway.example.invalid/v1/chat/completions", { method: "POST" })).rejects.toThrow(/tripwire/)
    expect(tripwire.refused).toEqual(["fetch:gateway.example.invalid"])
  })

  it("refuses a raw socket, a TLS socket and the agents' `path: null` form", async () => {
    expect(await socketOutcome(net.connect({ host: "provider.example.invalid", port: 443 }))).toMatch(/tripwire/)
    expect(await socketOutcome(tls.connect({ host: "provider.example.invalid", port: 443, servername: "provider.example.invalid" }))).toMatch(/tripwire/)
    expect(await socketOutcome(net.connect({ host: "provider.example.invalid", port: 443, path: null } as unknown as net.NetConnectOpts))).toMatch(/tripwire/)
    expect(await socketOutcome(new net.Socket().connect(443, "provider.example.invalid"))).toMatch(/tripwire/)
    expect(tripwire.refused).toHaveLength(4)
  })

  it("refuses an HTTP request to a non-loopback host", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = http.request({ host: "provider.example.invalid", port: 80, path: "/" }, () => resolve("answered"))
      req.on("error", (err) => resolve(err.message))
      req.end()
    })
    expect(outcome).toMatch(/tripwire/)
  })

  it("refuses the proxy's port even on loopback, for fetch and for sockets", async () => {
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${localPort}`)
    await expect(fetch(`http://127.0.0.1:${localPort}/`)).rejects.toThrow(/tripwire/)
    expect(await socketOutcome(net.connect({ host: "127.0.0.1", port: localPort }))).toMatch(/tripwire/)
    expect(localHits, "nothing reached the proxy").toBe(0)
  })

  it("lets loopback through (the emulators, the in-process Functions router)", async () => {
    const res = await fetch(`http://127.0.0.1:${localPort}/`)
    expect(await res.text()).toBe("ok")
    expect(await socketOutcome(net.connect({ host: "127.0.0.1", port: localPort }))).toBe("connected")
    expect(tripwire.refused).toEqual([])
  })
})
