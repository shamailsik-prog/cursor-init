/**
 * D2-1 included WhatsApp grammar (Layer 18 §8, FA-D2WA-002).
 *
 * Source: docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt
 * "8. WhatsApp Command Grammar". Eight commands, Urdu aliases as written there,
 * and the reply `open` / `kholo` / `کھولیں` plus a number. v6 names that §8 did
 * not keep are WA_31_CUT and are refused. The architecture calls that drop 23
 * commands; the prose names the set below and no further names.
 *
 * The channel flag is env-only (`SIKANDER_FLAG_D2_WHATSAPP_GRAMMAR`). It is not
 * in postgres/ddl (that tree is owned by another change). Unset means off.
 */

export const D2_WHATSAPP_GRAMMAR_FLAG = "D2_WHATSAPP_GRAMMAR"

export function isD2WhatsAppGrammarEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`]?.trim().toLowerCase() === "true"
}

export const INCLUDED_WHATSAPP_COMMANDS = [
  {
    name: "matters",
    usage: "/matters [Query|CaseRef]",
    urdu: "میرے کیس",
    aliases: ["میرے کیس", "میرےکیس", "مقدمات", "کیس"],
    args: "optional",
  },
  {
    name: "hearings",
    usage: "/hearings [Date]",
    urdu: "سماعت",
    aliases: ["سماعت", "پیشی"],
    args: "date",
  },
  {
    name: "clients",
    usage: "/clients [Query]",
    urdu: "کلائنٹ",
    aliases: ["کلائنٹ", "موکل"],
    args: "optional",
  },
  {
    name: "drafts",
    usage: "/drafts [CaseRef]",
    urdu: "مسودہ",
    aliases: ["مسودہ", "ڈرافٹ"],
    args: "optional",
  },
  {
    name: "research",
    usage: "/research <query>",
    urdu: "تحقیق",
    aliases: ["تحقیق", "ریسرچ"],
    args: "required",
  },
  {
    name: "presence",
    usage: "/presence [in|out]",
    urdu: "حاضری",
    aliases: ["حاضری"],
    args: "presence",
  },
  {
    name: "intake",
    usage: "/intake",
    urdu: "نیا کیس",
    aliases: ["نیا کیس", "نیاکیس"],
    args: "none",
  },
  {
    name: "help",
    usage: "/help",
    urdu: "مدد",
    aliases: ["مدد"],
    args: "none",
  },
] as const

export type IncludedCommand = (typeof INCLUDED_WHATSAPP_COMMANDS)[number]["name"]

/** v6 Module 36 names that Layer 18 §8 did not keep, plus the rejected ninth command `/note`. */
export const WA_31_CUT_COMMANDS = [
  "today",
  "conflict",
  "statutes",
  "limitation",
  "bail",
  "citations",
  "deadline",
  "report",
  "profile",
  "draft",
  "status",
  "find",
  "upload",
  "remind",
  "opinion",
  "job",
  "note",
] as const

const CUT = new Set<string>(WA_31_CUT_COMMANDS)

const ALIASES = INCLUDED_WHATSAPP_COMMANDS.flatMap((row) =>
  row.aliases.map((text) => ({ text, name: row.name }))
).sort((a, b) => b.text.length - a.text.length)

export type ParsedWhatsApp =
  | { kind: "command"; name: IncludedCommand; args: string; language: "en" | "ur" }
  | { kind: "reply"; n: number }
  | { kind: "cut"; name: string }
  | { kind: "unsupported" }
  | { kind: "malformed"; name?: string }

function normalise(text: string): string {
  return text.trim().replace(/[ \t]+/g, " ")
}

function rowOf(name: IncludedCommand) {
  const row = INCLUDED_WHATSAPP_COMMANDS.find((item) => item.name === name)
  if (!row) throw new Error(`missing command row ${name}`)
  return row
}

export function commandUsage(name: IncludedCommand, language: "en" | "ur"): string {
  const row = rowOf(name)
  return language === "ur" ? row.urdu : row.usage
}

function isIncluded(name: string): name is IncludedCommand {
  return INCLUDED_WHATSAPP_COMMANDS.some((row) => row.name === name)
}

function validIso(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function parseHearingDate(args: string, now: number): string | null {
  if (!args) return new Date(now).toISOString().slice(0, 10)
  const lower = args.toLowerCase()
  if (lower === "today") return new Date(now).toISOString().slice(0, 10)
  if (lower === "tomorrow") return new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(args) && validIso(args)) return args
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(args)
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2]}-${dmy[1]}`
    if (validIso(iso)) return iso
  }
  return null
}

function checkArgs(name: IncludedCommand, args: string, now: number): ParsedWhatsApp {
  const row = rowOf(name)
  if (row.args === "none" && args) return { kind: "malformed", name }
  if (row.args === "required" && !args) return { kind: "malformed", name }
  if (row.args === "presence" && args && args.toLowerCase() !== "in" && args.toLowerCase() !== "out") {
    return { kind: "malformed", name }
  }
  if (row.args === "date" && args && parseHearingDate(args, now) === null) return { kind: "malformed", name }
  return { kind: "command", name, args, language: "en" }
}

function fromName(name: string, args: string, language: "en" | "ur", now: number): ParsedWhatsApp {
  const lower = name.toLowerCase()
  if (CUT.has(lower)) return { kind: "cut", name: lower }
  if (!isIncluded(lower)) return { kind: "unsupported" }
  const checked = checkArgs(lower, args, now)
  if (checked.kind === "command") return { ...checked, language }
  return checked
}

export function parseWhatsAppMessage(input: string, now = Date.now()): ParsedWhatsApp {
  const text = normalise(input)
  if (!text) return { kind: "unsupported" }

  const latinReply = /^(?:\/)?(?:open|kholo)\s+(\d+)$/i.exec(text)
  const urduReply = /^کھولیں\s+(\d+)$/.exec(text)
  const reply = latinReply ?? urduReply
  if (reply) {
    const n = Number(reply[1])
    if (!Number.isInteger(n) || n < 1) return { kind: "malformed" }
    return { kind: "reply", n }
  }

  if (text.startsWith("/")) {
    const match = /^\/([A-Za-z]+)(?:\s+([\s\S]+))?$/.exec(text)
    if (!match) return { kind: "unsupported" }
    return fromName(match[1], (match[2] ?? "").trim(), "en", now)
  }

  for (const alias of ALIASES) {
    if (text === alias.text || text.startsWith(`${alias.text} `)) {
      return fromName(alias.name, text.slice(alias.text.length).trim(), "ur", now)
    }
  }

  const token = text.split(" ")[0]?.toLowerCase() ?? ""
  if (CUT.has(token)) return { kind: "cut", name: token }
  return { kind: "unsupported" }
}
