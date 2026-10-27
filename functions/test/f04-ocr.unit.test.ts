import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { handlerFor } from "../src/p2/registry"
import { aggregateClassification, isCompleteLegacyOcrJob, OCR_JOB_TYPE } from "../src/p2/ocrJob"
import {
  capOcrText,
  DeterministicLocalOcrEngine,
  LOCAL_OCR_PROVIDER,
  MAX_OCR_TEXT_BYTES,
  OcrTimeoutError,
  isProdLikeOcrRuntime,
  resolveOcrEngine,
  withOcrTimeout,
} from "../src/p1/ocrEngine"
import { summarizeOcrJobs } from "../../services/d1-6/ocrStatus"

const TEXT = "IN THE HIGH COURT OF SINDH\nSynthetic plaint 2099."

const legacy = {
  firmId: "firmA",
  jobType: "ocr",
  documentId: "doc_1",
  matterId: "matter_1",
  classification: "internal",
  idempotencyKey: "idem-1",
}

describe("F04 OCR engine and admission (no emulator)", () => {
  it("FA-F04-004: the local stub caps text by UTF-8 bytes so a Urdu document stays under 1 MiB", async () => {
    const engine = new DeterministicLocalOcrEngine()
    // U+FBAB is one BMP code point and three UTF-8 bytes. 400k of them are 1.2 MB.
    // A character cap of 500k leaves that whole string, which is over Firestore's 1 MiB document limit.
    const ch = "\u{FBAB}"
    const bytes = Buffer.from(ch.repeat(400_000), "utf8")
    const out = await engine.extract({ bytes, mimeType: "text/plain" })
    expect(MAX_OCR_TEXT_BYTES).toBe(900 * 1024)
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(MAX_OCR_TEXT_BYTES)
    expect(Buffer.from(out.text, "utf8").toString("utf8")).toBe(out.text)
    expect(out.text.endsWith(ch)).toBe(true)
    expect(out.lowConfidence).toBe(false)
  })

  it("FA-F04-004: a byte cap cuts on a code-point boundary", () => {
    const ch = "\u{FBAB}"
    expect(capOcrText(ch + ch, 4)).toBe(ch)
    expect(capOcrText(ch, 2)).toBe("")
    expect(capOcrText("abcd", 4)).toBe("abcd")
    const cut = capOcrText(ch.repeat(10), 7)
    expect(Buffer.byteLength(cut, "utf8")).toBe(6)
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut)
  })

  it("the local stub returns the UTF-8 text of a text document, and the same bytes twice", async () => {
    const engine = new DeterministicLocalOcrEngine()
    const bytes = Buffer.from(TEXT, "utf8")
    const first = await engine.extract({ bytes, mimeType: "text/plain" })
    const second = await engine.extract({ bytes, mimeType: "text/plain" })
    expect(first).toEqual(second)
    expect(first).toEqual({ text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER, truncated: false })
  })

  it("the local stub is deterministic on bytes that are not text and marks them low confidence", async () => {
    const engine = new DeterministicLocalOcrEngine()
    const bytes = Buffer.from([0, 1, 2, 3, 255, 65, 66, 67, 68])
    const first = await engine.extract({ bytes, mimeType: "application/pdf" })
    const second = await engine.extract({ bytes, mimeType: "application/pdf" })
    expect(first).toEqual(second)
    expect(first.lowConfidence).toBe(true)
    expect(first.confidence).toBeLessThan(0.7)
    expect(first.text).toBe("ABCD")
    expect(first.provider).toBe(LOCAL_OCR_PROVIDER)
  })

  it("resolveOcrEngine uses the stub only when no real provider is configured", () => {
    expect(resolveOcrEngine({})).toBeInstanceOf(DeterministicLocalOcrEngine)
    expect(resolveOcrEngine({ OCR_PROVIDER: "" })).toBeInstanceOf(DeterministicLocalOcrEngine)
    expect(resolveOcrEngine({ OCR_PROVIDER: "  local  " })).toBeInstanceOf(DeterministicLocalOcrEngine)
    expect(resolveOcrEngine({ OCR_PROVIDER: "vision" })).toBeNull()
    expect(resolveOcrEngine({ OCR_PROVIDER: "tesseract" })).toBeNull()
  })

  it("FA-F04-006: prod-like runtimes do not fall back to the stub when OCR_PROVIDER is unset or local", () => {
    expect(isProdLikeOcrRuntime({ NODE_ENV: "production" })).toBe(true)
    expect(isProdLikeOcrRuntime({ SIKANDER_DEPLOY_PROFILE: "staging" })).toBe(true)
    expect(isProdLikeOcrRuntime({ SIKANDER_DEPLOY_PROFILE: "production" })).toBe(true)
    expect(isProdLikeOcrRuntime({ NODE_ENV: "test" })).toBe(false)
    expect(isProdLikeOcrRuntime({ NODE_ENV: "development" })).toBe(false)

    expect(resolveOcrEngine({ NODE_ENV: "production" })).toBeNull()
    expect(resolveOcrEngine({ NODE_ENV: "production", OCR_PROVIDER: "" })).toBeNull()
    expect(resolveOcrEngine({ NODE_ENV: "production", OCR_PROVIDER: "local" })).toBeNull()
    expect(resolveOcrEngine({ NODE_ENV: "production", OCR_PROVIDER: "local-ocr-stub" })).toBeNull()
    expect(resolveOcrEngine({ NODE_ENV: "production", OCR_PROVIDER: "  Local  " })).toBeNull()
    expect(resolveOcrEngine({ SIKANDER_DEPLOY_PROFILE: "staging" })).toBeNull()
    expect(resolveOcrEngine({ SIKANDER_DEPLOY_PROFILE: "staging", OCR_PROVIDER: "local" })).toBeNull()
    expect(resolveOcrEngine({ NODE_ENV: "test", SIKANDER_DEPLOY_PROFILE: "staging" })).toBeNull()
    // Dev/test without a deploy profile may still use the stub.
    expect(resolveOcrEngine({ NODE_ENV: "test" })).toBeInstanceOf(DeterministicLocalOcrEngine)
    // A name this build has not registered through the egress gate stays closed in every environment.
    expect(resolveOcrEngine({ NODE_ENV: "test", OCR_PROVIDER: "vision" })).toBeNull()
  })

  it("FA-F04-008: text over the UTF-8 cap is marked truncated, and shorter text is not", async () => {
    const engine = new DeterministicLocalOcrEngine()
    const ch = "\u{FBAB}"
    const over = await engine.extract({ bytes: Buffer.from(ch.repeat(400_000), "utf8"), mimeType: "text/plain" })
    expect(over.truncated).toBe(true)
    expect(Buffer.byteLength(over.text, "utf8")).toBeLessThanOrEqual(MAX_OCR_TEXT_BYTES)
    const under = await engine.extract({ bytes: Buffer.from(TEXT, "utf8"), mimeType: "text/plain" })
    expect(under.truncated).toBe(false)
    expect(under.text).toBe(TEXT)
  })

  it("withOcrTimeout rejects work that outlives the budget and returns work that does not", async () => {
    await expect(withOcrTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok")
    let timer: NodeJS.Timeout | undefined
    const slow = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("late"), 300)
    })
    await expect(withOcrTimeout(slow, 20)).rejects.toBeInstanceOf(OcrTimeoutError)
    clearTimeout(timer)
  })

  it("aggregate classification is the max of the sources and refuses an empty set", () => {
    expect(aggregateClassification(["internal", "privileged", "confidential"])).toBe("privileged")
    expect(aggregateClassification(["public"])).toBe("public")
    expect(aggregateClassification(["privileged-restricted", "internal"])).toBe("privileged-restricted")
    expect(() => aggregateClassification([])).toThrow()
  })

  it("a legacy OCR row is complete only in the upload writer's shape", () => {
    expect(isCompleteLegacyOcrJob(undefined)).toBe(false)
    expect(isCompleteLegacyOcrJob({ jobType: "ocr" })).toBe(false)
    expect(isCompleteLegacyOcrJob({ ...legacy, engine: "p2" })).toBe(false)
    expect(isCompleteLegacyOcrJob({ ...legacy, jobType: "platform.diagnostic" })).toBe(false)
    expect(isCompleteLegacyOcrJob({ ...legacy, matterId: "bad/id" })).toBe(false)
    expect(isCompleteLegacyOcrJob({ ...legacy, classification: "secret" })).toBe(false)
    expect(isCompleteLegacyOcrJob({ ...legacy, matterId: null })).toBe(true)
    expect(isCompleteLegacyOcrJob(legacy)).toBe(true)
  })

  it("the OCR handler is registered on the P2 engine", () => {
    expect(handlerFor(OCR_JOB_TYPE)?.jobType).toBe(OCR_JOB_TYPE)
  })

  it("the OCR handler reaches an engine only through callP1Ocr", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/p2/ocrJob.ts"), "utf8")
    expect(src).toContain("callP1Ocr")
    expect(src).not.toContain("ocrEngine")
    expect(src).not.toContain("DeterministicLocalOcrEngine")
    expect(src).not.toContain("resolveOcrEngine")
  })

  it("the stub module does not call a network or a real OCR binary", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/p1/ocrEngine.ts"), "utf8")
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/from ["']https?/)
    expect(src).not.toMatch(/tesseract|vision|child_process/i)
  })
})

describe("F04 user-visible OCR status", () => {
  it("summarises the document's OCR jobs, treating a missing status as queued", () => {
    expect(summarizeOcrJobs([])).toEqual({ ocrJobs: 0, ocrStatus: "none" })
    expect(summarizeOcrJobs([{ jobType: "index" }])).toEqual({ ocrJobs: 0, ocrStatus: "none" })
    expect(summarizeOcrJobs([{ jobType: "ocr" }])).toEqual({ ocrJobs: 1, ocrStatus: "queued" })
    expect(summarizeOcrJobs([{ jobType: "ocr", ocrStatus: "done" }])).toEqual({ ocrJobs: 1, ocrStatus: "done" })
    expect(
      summarizeOcrJobs([
        { jobType: "ocr", ocrStatus: "done" },
        { jobType: "ocr", ocrStatus: "failed" },
      ])
    ).toEqual({ ocrJobs: 2, ocrStatus: "failed" })
    expect(
      summarizeOcrJobs([
        { jobType: "ocr", ocrStatus: "running" },
        { jobType: "ocr", ocrStatus: "queued" },
      ])
    ).toEqual({ ocrJobs: 2, ocrStatus: "running" })
    expect(
      summarizeOcrJobs([
        { jobType: "ocr", ocrStatus: "done" },
        { jobType: "ocr" },
      ])
    ).toEqual({ ocrJobs: 2, ocrStatus: "queued" })
  })
})
