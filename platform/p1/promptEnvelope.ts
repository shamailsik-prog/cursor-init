/**
 * The untrusted-content envelope (audit F16; spec docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md,
 * ruling 2). Content that is not authored by the platform or by the authenticated user's own turn (a tool result, a
 * document, a tool call's arguments) travels as
 *
 *   <untrusted_content source="tool:mask_preview">
 *   ...the content...
 *   </untrusted_content>
 *
 * with each marker on its own line, and the system policy (platform/p1/systemPolicy.ts) tells the model that what lies
 * between the markers is data, never instructions.
 *
 * The envelope cannot be closed from inside: every non-platform text that leaves is neutralised first. A look-alike of
 * the tag name is found on F15's name view (platform/p1/piiText.ts: case folded, NFKC compatibility forms such as
 * full-width letters and brackets, Cyrillic and Greek look-alikes folded, format, default-ignorable, combining and
 * private-use characters dropped, `_` and `-` read as a space, `.` dropped) with every whitespace and control character
 * except a line feed squeezed out, so the name split by spaces, underscores, invisibles or brackets in any form is still
 * found; a line feed is a boundary. The look-alike's original span, with a `<` or `</` just before it and a `>` just
 * after it, is replaced by NEUTRALISED_TAG. The platform's markers are added after neutralisation, each on its own line,
 * so no look-alike can straddle one. `envelopeIntegrity` re-checks an assembled message.
 */

import { detectionView, nameView } from "@/platform/p1/piiText"

export const ENVELOPE_TAG = "untrusted_content"
export const ENVELOPE_CLOSE = `</${ENVELOPE_TAG}>`
/** What a tag-name look-alike in non-platform text becomes. */
export const NEUTRALISED_TAG = "[envelope tag removed]"

/** `tool:<name>`, `tool-call:<name>` or `document:<name>`: lower-case, at most 64 characters after the colon. */
const SOURCE = /^(?:tool|tool-call|document):[a-z][a-z0-9_-]{0,63}$/
/** The tag name as it reads on the squeezed name view. */
const NAME = "untrustedcontent"
/** Squeezed out of the view: whitespace and control characters; a line feed stays (it is a boundary). */
const SQUEEZE = /[\s\p{Cc}]/u
const OPEN_LINE = /^<untrusted_content source="([^"]*)">$/

type Squeezed = { text: string; start: number[]; end: number[] }

function squeezedView(text: string): Squeezed {
  const view = nameView(detectionView(text))
  const parts: string[] = []
  const start: number[] = []
  const end: number[] = []
  for (let i = 0; i < view.text.length; i++) {
    const ch = view.text[i]!
    if (ch !== "\n" && SQUEEZE.test(ch)) continue
    parts.push(ch)
    start.push(view.start[i]!)
    end.push(view.end[i]!)
  }
  return { text: parts.join(""), start, end }
}

/** The original spans [start, end) of every tag-name look-alike in `text`, brackets included, in order, not overlapping. */
function lookalikeSpans(text: string): Array<[number, number]> {
  if (text === "") return []
  const sq = squeezedView(text)
  const spans: Array<[number, number]> = []
  let from = 0
  for (let i = sq.text.indexOf(NAME, from); i !== -1; i = sq.text.indexOf(NAME, from)) {
    let first = i
    let last = i + NAME.length - 1
    // A `<` or `</` (in any form the view reads as one) just before the name, and a `>` just after it.
    if (sq.text[first - 1] === "<") first -= 1
    else if (sq.text[first - 1] === "/" && sq.text[first - 2] === "<") first -= 2
    if (sq.text[last + 1] === ">") last += 1
    const span: [number, number] = [sq.start[first]!, sq.end[last]!]
    const prev = spans[spans.length - 1]
    if (prev !== undefined && span[0] < prev[1]) prev[1] = Math.max(prev[1], span[1])
    else spans.push(span)
    from = i + NAME.length
  }
  return spans
}

/** The number of tag-name look-alikes in `text` (platform markers count too: one each). */
export function envelopeTagCount(text: string): number {
  return lookalikeSpans(text).length
}

/** `text` with every tag-name look-alike replaced by NEUTRALISED_TAG, and how many there were. Idempotent. */
export function neutraliseEnvelopeTags(text: string): { text: string; count: number } {
  const spans = lookalikeSpans(text)
  if (spans.length === 0) return { text, count: 0 }
  let out = ""
  let at = 0
  for (const [start, end] of spans) {
    out += text.slice(at, start) + NEUTRALISED_TAG
    at = end
  }
  return { text: out + text.slice(at), count: spans.length }
}

/** True for a source the envelope may name: the grammar above, and no tag-name look-alike in it. */
export function isEnvelopeSource(source: unknown): source is string {
  return typeof source === "string" && SOURCE.test(source) && envelopeTagCount(source) === 0
}

/** The opening marker for `source`; throws for a source outside the grammar (fail closed). */
export function envelopeOpen(source: string): string {
  if (!isEnvelopeSource(source)) throw new Error("P1: invalid envelope source")
  return `<${ENVELOPE_TAG} source="${source}">`
}

/** Text that is already neutralised, between the markers, each on its own line. */
export function wrapNeutralised(source: string, neutralised: string): string {
  return `${envelopeOpen(source)}\n${neutralised}\n${ENVELOPE_CLOSE}`
}

/** `text` neutralised and wrapped in an envelope naming `source`. */
export function wrapUntrusted(source: string, text: string): string {
  const open = envelopeOpen(source)
  return `${open}\n${neutraliseEnvelopeTags(text).text}\n${ENVELOPE_CLOSE}`
}

/**
 * True when every tag-name look-alike in `content` is a platform marker on its own line (an opening marker with a valid
 * source, or the closing marker), the markers alternate open, close, open, close, with no nesting, and none is left
 * open. A message with no look-alike passes.
 */
export function envelopeIntegrity(content: string): boolean {
  let inside = false
  for (const line of content.split("\n")) {
    const n = envelopeTagCount(line)
    if (n === 0) continue
    if (n !== 1) return false
    const open = OPEN_LINE.exec(line)
    if (!inside && open !== null && isEnvelopeSource(open[1])) inside = true
    else if (inside && line === ENVELOPE_CLOSE) inside = false
    else return false
  }
  return !inside
}
