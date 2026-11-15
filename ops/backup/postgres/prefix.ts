/**
 * Operator-only command prefix. The drill prepends it to psql, pg_dump, pg_dumpall and pg_restore.
 * The only accepted shape is docker exec or docker compose exec with a fixed flag set.
 * A shell wrapper, a tee, or any other argv is refused before a process is spawned.
 */

const REFUSAL = "command prefix is not an allowlisted docker exec form"
const USER = /^[A-Za-z_][A-Za-z0-9_-]*$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SERVICE = /^[a-z][a-z0-9_-]*$/
const REL_PATH = /^[A-Za-z0-9_./-]+$/

function refused(): string[] {
  return [REFUSAL]
}

function relativePath(value: string | undefined): boolean {
  if (!value || !REL_PATH.test(value) || value.startsWith("/")) return false
  return !value.split("/").includes("..")
}

function dockerExec(args: string[]): string[] {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === "-i" || arg === "--interactive") {
      i += 1
      continue
    }
    if (arg === "-u" || arg === "--user") {
      if (!USER.test(args[i + 1] ?? "")) return refused()
      i += 2
      continue
    }
    if (arg.startsWith("--user=")) {
      if (!USER.test(arg.slice("--user=".length))) return refused()
      i += 1
      continue
    }
    break
  }
  if (i !== args.length - 1 || !NAME.test(args[i] ?? "")) return refused()
  return []
}

function dockerCompose(args: string[]): string[] {
  let i = 0
  while (i < args.length && args[i] !== "exec") {
    if (args[i] === "-f" || args[i] === "--file") {
      if (!relativePath(args[i + 1])) return refused()
      i += 2
      continue
    }
    if (args[i] === "-p" || args[i] === "--project-name") {
      if (!NAME.test(args[i + 1] ?? "")) return refused()
      i += 2
      continue
    }
    return refused()
  }
  if (args[i] !== "exec") return refused()
  i += 1
  let sawNoTty = false
  while (i < args.length) {
    const arg = args[i]
    if (arg === "-T" || arg === "--no-TTY") {
      sawNoTty = true
      i += 1
      continue
    }
    if (arg === "-u" || arg === "--user") {
      if (!USER.test(args[i + 1] ?? "")) return refused()
      i += 2
      continue
    }
    if (arg.startsWith("--user=")) {
      if (!USER.test(arg.slice("--user=".length))) return refused()
      i += 1
      continue
    }
    break
  }
  if (!sawNoTty || !SERVICE.test(args[i] ?? "")) return refused()
  i += 1
  if (i === args.length) return []
  if (args[i] === "gosu" && i === args.length - 2 && USER.test(args[i + 1] ?? "")) return []
  return refused()
}

/** Empty means the programs run directly. Anything else must be an allowlisted docker exec form. */
export function operatorPrefixProblems(prefix: readonly string[] | undefined): string[] {
  if (!prefix || prefix.length === 0) return []
  if (prefix.some((arg) => arg.length === 0 || /[\0\r\n]/.test(arg))) return refused()
  if (prefix[0] === "docker" && prefix[1] === "exec") return dockerExec(prefix.slice(2))
  if (prefix[0] === "docker" && prefix[1] === "compose") return dockerCompose(prefix.slice(2))
  if (prefix[0] === "docker-compose") return dockerCompose(prefix.slice(1))
  return refused()
}
