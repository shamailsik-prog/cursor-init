import { isProdLikeFunctionsRuntime } from "../deployRuntimeProfile"

/**
 * OCR engine boundary (audit F04, erratum E-20).
 *
 * The worker does not call a provider. `callP1Ocr` is the only caller, and it asks
 * `resolveOcrEngine` which implementation to use. Outside prod-like runtimes, `OCR_PROVIDER` unset
 * or `local` selects the deterministic in-process stub below: same bytes, same text, no network.
 * Prod-like runtimes fail closed unless the name is registered in `OCR_EGRESS_PROVIDERS`, which is
 * where a real provider implemented inside the Functions control plane (the F18 egress gate
 * leaves that plane in place) would be wired. The map is empty in this build.
 * No remote image API and no local OCR binary are wired.
 */

export const LOCAL_OCR_PROVIDER = "local-ocr-stub" as const

/**
 * Cap on UTF-8 bytes published from one document. Firestore refuses a document over 1 MiB.
 * 900 KiB leaves room for the other fields on the operation row and on `ocr_texts`.
 */
export const MAX_OCR_TEXT_BYTES = 900 * 1024

/** Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`, cut on a code-point boundary. */
export function capOcrText(text: string, maxBytes: number = MAX_OCR_TEXT_BYTES): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString("utf8")
}

/** `capOcrText` plus whether the UTF-8 byte length was reduced. A code-point cut is still valid UTF-8. */
export function measureOcrText(text: string, maxBytes: number = MAX_OCR_TEXT_BYTES): { text: string; truncated: boolean } {
  const capped = capOcrText(text, maxBytes)
  return { text: capped, truncated: Buffer.byteLength(text, "utf8") > Buffer.byteLength(capped, "utf8") }
}

export type OcrExtraction = {
  text: string
  /** 0 to 1. Text the stub could read as UTF-8 is 1. Anything else is below 0.7. */
  confidence: number
  lowConfidence: boolean
  provider: typeof LOCAL_OCR_PROVIDER
  /** True when `text` is a prefix because the UTF-8 cap was applied. Absent means not truncated. */
  truncated?: boolean
}

export type OcrEngine = {
  readonly id: typeof LOCAL_OCR_PROVIDER
  extract(input: { bytes: Buffer; mimeType: string }): Promise<OcrExtraction>
}

function isPrintable(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
}

/** UTF-8 text with no NUL and a printable ratio of at least 0.9. Otherwise null. */
function plainText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) return null
  if (text.length === 0) return ""
  let printable = 0
  let count = 0
  for (const ch of text) {
    count += 1
    const code = ch.codePointAt(0)
    if (code !== undefined && isPrintable(code)) printable += 1
  }
  if (count === 0 || printable / count < 0.9) return null
  return text
}

/** Printable ASCII runs of at least four characters, in order. Stable for a given buffer. */
function printableRuns(bytes: Buffer): string {
  const parts: string[] = []
  let run = ""
  for (const byte of bytes) {
    if (byte >= 32 && byte < 127) {
      run += String.fromCharCode(byte)
      continue
    }
    if (run.length >= 4) parts.push(run)
    run = ""
  }
  if (run.length >= 4) parts.push(run)
  return parts.join("\n")
}

/**
 * Deterministic local OCR. Text bytes come back as that text. Other bytes come back as their
 * printable ASCII runs, flagged low confidence. There is no clock, no random value and no I/O.
 */
export class DeterministicLocalOcrEngine implements OcrEngine {
  readonly id = LOCAL_OCR_PROVIDER

  async extract(input: { bytes: Buffer; mimeType: string }): Promise<OcrExtraction> {
    void input.mimeType
    const text = plainText(input.bytes)
    if (text !== null) {
      const capped = measureOcrText(text)
      return {
        text: capped.text,
        truncated: capped.truncated,
        confidence: 1,
        lowConfidence: false,
        provider: LOCAL_OCR_PROVIDER,
      }
    }
    const runs = measureOcrText(printableRuns(input.bytes))
    return {
      text: runs.text,
      truncated: runs.truncated,
      confidence: runs.text.length > 0 ? 0.4 : 0,
      lowConfidence: true,
      provider: LOCAL_OCR_PROVIDER,
    }
  }
}

/**
 * Real OCR providers implemented under `functions/src/p1` (the control plane the F18 egress gate
 * allows). Empty: this build has no remote provider, so production never selects an engine.
 */
export const OCR_EGRESS_PROVIDERS: Readonly<Record<string, () => OcrEngine>> = Object.freeze({})

/**
 * Deployed/staging runtimes must not silently use the local stub.
 *
 * Delegates to `isProdLikeFunctionsRuntime` (FA-F04-006-002: prod/stage/unknown profiles and
 * case-normalized NODE_ENV off-bundle; deployed bundle always prod-like via build.mjs define).
 */
export function isProdLikeOcrRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return isProdLikeFunctionsRuntime(env)
}

/**
 * Outside prod-like runtimes, `OCR_PROVIDER` unset or `local` selects the stub. Prod-like returns null
 * unless `name` is registered in `OCR_EGRESS_PROVIDERS`. Any other name is unsupported (null).
 */
export function resolveOcrEngine(env: NodeJS.ProcessEnv = process.env): OcrEngine | null {
  const name = (env.OCR_PROVIDER ?? "").trim().toLowerCase()
  const gated = OCR_EGRESS_PROVIDERS[name]
  if (gated) return gated()
  if (isProdLikeOcrRuntime(env)) return null
  if (name === "" || name === "local" || name === "local-ocr-stub") return new DeterministicLocalOcrEngine()
  return null
}

export class OcrTimeoutError extends Error {
  constructor() {
    super("ocr_timeout")
    this.name = "OcrTimeoutError"
  }
}

/** Races `work` against `ms`. The timer is cleared when the race settles. */
export async function withOcrTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new OcrTimeoutError()), ms)
      work.then(resolve, reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}
