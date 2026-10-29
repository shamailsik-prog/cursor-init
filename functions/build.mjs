import { build } from "esbuild"
import { rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..")

// pg's optional native binding (pg-native) is never installed or used: the F05 corpus reader runs on pure-JS pg.
const EXTERNAL = ["firebase-admin", "firebase-functions", "pg-native"]
const shared = { bundle: true, platform: "node", target: "node22", format: "cjs", external: EXTERNAL, alias: { "@": repoRoot } }

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
  external: EXTERNAL,
  alias: { "@": repoRoot },
  // Defence in depth: the deployed bundle is production whatever the host's NODE_ENV, so the test seams that
  // check it (p1TestSeam, p1OpsTestSeam; the set*ForTests refusals) stay inert. The route check and the
  // operator CLI are not deployed and keep the runtime value.
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
})

// Operator CLIs (not deployed exports): `npm run jobs:backfill`, `npm run p1:decision` (audit F34: the reconstruction of
// one P1 attempt from durable data), and `npm run eval:committee-live` (audit F17: the live
// evaluation of docs/evals/committee-brain-eval-set.json, which reports NOT RUN without AI_GATEWAY_API_KEY).
for (const cli of ["jobsBackfill", "committeeEval", "p1Decision", "partnerIndependenceBackfill"]) {
  await build({
    entryPoints: [path.join(here, `src/cli/${cli}.ts`)],
    outfile: path.join(here, `lib/cli/${cli}.js`),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: true,
    external: EXTERNAL,
    alias: { "@": repoRoot },
    logLevel: "info",
  })
}
