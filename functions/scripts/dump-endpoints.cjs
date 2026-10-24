#!/usr/bin/env node
"use strict"
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const cwd = path.resolve(__dirname, "..")
execFileSync(process.execPath, ["build.mjs"], { cwd, stdio: "ignore" })
const env = {
  ...process.env,
  SIKANDER_INGRESS_SETTINGS: process.env.SIKANDER_INGRESS_SETTINGS ?? "ALLOW_INTERNAL_AND_GCLB",
  TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS ?? "1",
}
const mod = require(path.join(cwd, "lib/index.js"))
const out = {}
for (const key of Object.keys(mod)) {
  const ep = mod[key]?.__endpoint
  if (ep) out[key] = ep
}
process.stdout.write(JSON.stringify(out))
