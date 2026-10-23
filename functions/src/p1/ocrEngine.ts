/**
 * OCR engine boundary (audit F04, erratum E-20).
 *
 * The worker does not call a provider. `callP1Ocr` is the only caller, and it asks
 * `resolveOcrEngine` which implementation to use. With `OCR_PROVIDER` unset or `local`,
 * that is the deterministic in-process stub below: same bytes, same text, no network.
 * A named provider this build does not implement resolves to null and the call fails closed.
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

export type OcrExtraction = {
  text: string
  /** 0 to 1. Text the stub could read as UTF-8 is 1. Anything else is below 0.7. */
  confidence: number
  lowConfidence: boolean
  provider: typeof LOCAL_OCR_PROVIDER
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
      return {
        text: capOcrText(text),
        confidence: 1,
        lowConfidence: false,
        provider: LOCAL_OCR_PROVIDER,
      }
    }
    const runs = capOcrText(printableRuns(input.bytes))
    return {
      text: runs,
      confidence: runs.length > 0 ? 0.4 : 0,
      lowConfidence: true,
      provider: LOCAL_OCR_PROVIDER,
    }
  }
}

/** `OCR_PROVIDER` unset or `local` selects the stub. Any other name is unsupported (null). */
export function resolveOcrEngine(env: NodeJS.ProcessEnv = process.env): OcrEngine | null {
  const name = (env.OCR_PROVIDER ?? "").trim().toLowerCase()
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
