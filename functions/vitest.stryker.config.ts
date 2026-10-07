import fs from "node:fs"
import path from "node:path"
import { defineConfig, mergeConfig } from "vitest/config"
import base from "./vitest.config"

// Used only by StrykerJS (stryker.config.mjs). Stryker copies functions/ into
// a sandbox (functions/.stryker-tmp/sandbox-*), so the base config's
// `@` -> ".." alias would point inside .stryker-tmp: resolve the repository
// root (the directory holding firebase.json and platform/) by walking up.
function repoRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "firebase.json")) && fs.existsSync(path.join(dir, "platform"))) return dir
    if (path.dirname(dir) === dir) throw new Error(`no repository root above ${from}`)
  }
}

export default mergeConfig(
  base,
  defineConfig({
    // Every Stryker worker claims its own emulator set (test/setup/stryker-emulators.ts).
    test: { setupFiles: ["test/setup/stryker-emulators.ts"] },
    resolve: { alias: { "@": repoRoot(__dirname) } },
  })
)
