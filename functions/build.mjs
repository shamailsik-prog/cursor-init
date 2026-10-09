import { build } from "esbuild"
import { rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")

const shared = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["firebase-admin", "firebase-functions"], alias: { "@": repoRoot } }

// Static route check (L18 §4.1): load the route table and index it, so a
// duplicate method + path fails `npm run build` before anything is bundled.
const routeCheck = path.join(here, "lib", ".route-check.cjs")
await build({ ...shared, entryPoints: [path.join(here, "src/http/router.ts")], outfile: routeCheck, logLevel: "warning" })
try {
  const { ROUTES, buildRouteTable } = createRequire(import.meta.url)(routeCheck)
  buildRouteTable(ROUTES)
  console.log(`route check: ${ROUTES.length} routes, no duplicates`)
} finally {
  rmSync(routeCheck, { force: true })
}

// Bundles shared repo code (`@/*` -> repo root) into a single deployable file.
await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(here, "lib/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["firebase-admin", "firebase-functions"],
  alias: { "@": repoRoot },
  logLevel: "info",
})

// Operator CLI (not a deployed export): `npm run jobs:backfill`.
await build({
  entryPoints: [path.join(here, "src/cli/jobsBackfill.ts")],
  outfile: path.join(here, "lib/cli/jobsBackfill.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["firebase-admin", "firebase-functions"],
  alias: { "@": repoRoot },
  logLevel: "info",
})
