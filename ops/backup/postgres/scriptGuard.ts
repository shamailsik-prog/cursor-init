/**
 * Fail-closed scan of a psql script.
 * The only meta-commands passed through are a line-start `\connect`, `\restrict`, or `\unrestrict`
 * in the shape pg_restore and pg_dumpall emit. Any other backslash command, a meta-command that is
 * not at the start of the line, `\ir` / `\i`, or a `:name` interpolation is refused.
 * COPY data is not scanned for meta-commands. The scanner keeps only the current line, so a multi-megabyte
 * COPY row is not accumulated.
 */

export class ScriptGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScriptGuardError"
  }
}

const MAX_LINE = 256 * 1024
const MAX_META = 4096

type Mode = "sql" | "sq" | "dq" | "dollar" | "linecom" | "block" | "meta" | "copy"

function classifyMeta(line: string): "connect" | "restrict" | "refuse" {
  const body = line.endsWith("\n") ? line.slice(0, -1) : line
  if (/^\\connect(\s.*)?$/i.test(body)) return "connect"
  if (/^\\restrict(\s\S+)?$/i.test(body)) return "restrict"
  if (/^\\unrestrict(\s\S+)?$/i.test(body)) return "restrict"
  return "refuse"
}

export type ScriptGuard = {
  push(chunk: string): string
  end(): string
  bufferedBytes(): number
}

export function createScriptGuard(guardBlock: string, copyIsData: () => boolean): ScriptGuard {
  const guard = guardBlock.endsWith("\n") ? guardBlock : `${guardBlock}\n`
  let mode: Mode = "sql"
  let atLine = true
  let sqlLine = ""
  let meta = ""
  let dollar = ""
  let copyHold = ""
  let hold = ""
  let eStr = false
  let blockDepth = 0
  let maxBuffered = 0

  const note = () => {
    const n = sqlLine.length + meta.length + dollar.length + copyHold.length + hold.length
    if (n > maxBuffered) maxBuffered = n
  }

  const refuse = (why: string): never => {
    throw new ScriptGuardError(why)
  }

  const feed = (input: string): string => {
    let out = ""
    const s = hold + input
    hold = ""
    let i = 0
    const emit = (text: string) => {
      out += text
    }

    while (i < s.length) {
      const c = s[i]
      note()

      if (mode === "copy") {
        if (atLine && copyHold === "\\.") {
          if (c === "\n") {
            emit("\\.\n")
            i += 1
            copyHold = ""
            mode = "sql"
            atLine = true
            sqlLine = ""
            continue
          }
          emit(copyHold)
          copyHold = ""
          atLine = false
          continue
        }
        if (atLine) {
          copyHold += c
          i += 1
          if (copyHold === "\\") continue
          if (copyHold === "\\.") {
            if (i >= s.length) break
            continue
          }
          emit(copyHold)
          atLine = false
          copyHold = ""
          continue
        }
        emit(c)
        atLine = c === "\n"
        i += 1
        continue
      }

      if (mode === "meta") {
        meta += c
        i += 1
        if (meta.length > MAX_META) refuse("psql meta-command is not allowlisted")
        if (c === "\n") {
          const kind = classifyMeta(meta)
          if (kind === "refuse") refuse(`psql meta-command is not allowlisted: ${meta.trim().slice(0, 80)}`)
          emit(meta)
          if (kind === "connect") emit(guard)
          meta = ""
          mode = "sql"
          atLine = true
          sqlLine = ""
        }
        continue
      }

      if (mode === "linecom") {
        emit(c)
        i += 1
        if (c === "\n") {
          mode = "sql"
          atLine = true
          sqlLine = ""
        }
        continue
      }

      if (mode === "block") {
        if (c === "*" && s[i + 1] === "/") {
          emit("*/")
          i += 2
          blockDepth -= 1
          if (blockDepth <= 0) mode = "sql"
          continue
        }
        if (c === "/" && s[i + 1] === "*") {
          emit("/*")
          i += 2
          blockDepth += 1
          continue
        }
        if (i + 1 >= s.length && (c === "*" || c === "/")) {
          hold = s.slice(i)
          break
        }
        emit(c)
        i += 1
        continue
      }

      if (mode === "dollar") {
        if (c === "$" && s.startsWith(dollar, i)) {
          emit(dollar)
          i += dollar.length
          mode = "sql"
          continue
        }
        if (c === "$" && i + dollar.length > s.length) {
          hold = s.slice(i)
          break
        }
        emit(c)
        if (c === "\n") {
          atLine = true
          sqlLine = ""
        }
        i += 1
        continue
      }

      if (mode === "sq" || mode === "dq") {
        const quote = mode === "sq" ? "'" : '"'
        if (mode === "sq" && eStr && c === "\\") {
          if (i + 1 >= s.length) {
            hold = s.slice(i)
            break
          }
          emit(c + s[i + 1])
          i += 2
          continue
        }
        emit(c)
        i += 1
        if (c === quote) {
          if (mode === "sq" && s[i] === "'") {
            emit("'")
            i += 1
            continue
          }
          mode = "sql"
          eStr = false
        }
        continue
      }

      if (atLine && (c === " " || c === "\t" || c === "\r")) {
        sqlLine += c
        emit(c)
        i += 1
        if (sqlLine.length > MAX_LINE) refuse("psql script line cannot be classified")
        continue
      }

      if (atLine && c === "\\") {
        mode = "meta"
        meta = "\\"
        i += 1
        continue
      }

      if (c === "\\") refuse("psql meta-command is not allowlisted")

      const next = s[i + 1]
      if ((c === "-" || c === "/" || c === ":" || c === "$" || c === "E" || c === "e") && next === undefined) {
        hold = s.slice(i)
        break
      }
      if (c === "-" && next === "-") {
        mode = "linecom"
        emit("--")
        i += 2
        atLine = false
        continue
      }
      if (c === "/" && next === "*") {
        mode = "block"
        blockDepth = 1
        emit("/*")
        i += 2
        atLine = false
        continue
      }
      if (c === "$") {
        const rest = s.slice(i)
        const matched = /^\$([A-Za-z0-9_]*)\$/.exec(rest)
        if (!matched) {
          if (/^\$[A-Za-z0-9_]*$/.test(rest)) {
            hold = rest
            break
          }
          emit(c)
          sqlLine += c
          atLine = false
          i += 1
          continue
        }
        dollar = matched[0]
        mode = "dollar"
        emit(dollar)
        i += dollar.length
        atLine = false
        continue
      }
      if (c === ":") {
        if (next === ":") {
          emit("::")
          sqlLine += "::"
          i += 2
          atLine = false
          continue
        }
        if (next === "'" || next === '"') refuse("psql variable interpolation is not allowed")
        if (/[A-Za-z_]/.test(next)) refuse("psql variable interpolation is not allowed")
      }
      if ((c === "E" || c === "e") && next === "'") {
        mode = "sq"
        eStr = true
        emit(c + "'")
        i += 2
        atLine = false
        continue
      }
      if (c === "'") {
        mode = "sq"
        eStr = false
        emit(c)
        i += 1
        atLine = false
        continue
      }
      if (c === '"') {
        mode = "dq"
        emit(c)
        i += 1
        atLine = false
        continue
      }

      emit(c)
      if (c === "\n") {
        const finished = sqlLine
        sqlLine = ""
        atLine = true
        if (/^COPY\s/i.test(finished.trim()) && /\bFROM\s+stdin\s*;\s*$/i.test(finished.trim())) {
          if (copyIsData()) mode = "copy"
        }
        if (finished.length > MAX_LINE) refuse("psql script line cannot be classified")
      } else {
        sqlLine += c
        atLine = false
        if (sqlLine.length > MAX_LINE) refuse("psql script line cannot be classified")
      }
      i += 1
    }
    note()
    return out
  }

  return {
    push(chunk: string) {
      return feed(chunk)
    },
    end() {
      let extra = ""
      if (hold) {
        const pending = hold
        hold = ""
        extra += feed(pending)
      }
      if (mode === "copy") refuse("psql script cannot be classified")
      if (copyHold) {
        extra += copyHold
        copyHold = ""
      }
      if (mode === "meta" || mode === "dollar" || mode === "sq" || mode === "dq") {
        refuse("psql script cannot be classified")
      }
      return extra
    },
    bufferedBytes() {
      return maxBuffered
    },
  }
}
