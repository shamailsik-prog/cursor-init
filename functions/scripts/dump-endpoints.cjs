#!/usr/bin/env node
"use strict"
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const cwd = path.resolve(__dirname, "..")
execFileSync(process.execPath, ["build.mjs"], { cwd, stdio: "ignore" })
const mod = require(path.join(cwd, "lib/index.js"))
const out = {}
for (const key of Object.keys(mod)) {
  const ep = mod[key]?.__endpoint
  if (ep) out[key] = ep
}
process.stdout.write(JSON.stringify(out))
