// Runs the dashboard <script> under stubbed browser globals. Scenario from argv JSON.
import vm from "node:vm"
import fs from "node:fs"
const html = fs.readFileSync(process.argv[2], "utf8")
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
const prompts = JSON.parse(process.argv[3]) // successive prompt() answers
let unhandled = 0
process.on("unhandledRejection", () => { unhandled++ })
const store = new Map()
const els = {}
let tick = null
const calls = { prompt: 0, feed: 0 }
const ctx = {
  sessionStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  prompt: () => { calls.prompt++; return prompts.shift() ?? null },
  confirm: () => true,
  setInterval: (fn) => { tick = fn },
  document: { getElementById: (id) => (els[id] ??= { innerText: "" }) },
  fetch: async (path, opts = {}) => {
    if (path === "/health") return { status: 200, json: async () => ({ total_pdfs: 1, seen: 2 }) }
    if (path === "/api/boom") throw new TypeError("network down")
    calls.feed++
    const ok = (opts.headers || {})["X-API-Key"] === "good"
    return ok ? { status: 200, json: async () => ({ feed: ["line"] }) } : { status: 401, json: async () => ({}) }
  },
}
vm.createContext(ctx)
vm.runInContext(script, ctx)
const settle = () => new Promise((r) => setTimeout(r, 20))
;(async () => {
  await settle()
  for (let i = 0; i < 3; i++) { tick(); await settle() }
  const before = { ...calls }
  vm.runInContext("api('/api/boom').catch(()=>{})", ctx)
  await settle()
  vm.runInContext("unlock()", ctx)
  await settle()
  tick(); await settle()
  console.log(JSON.stringify({ before, after: calls, unhandled, feed: els.feed?.innerText ?? "" }))
})()
