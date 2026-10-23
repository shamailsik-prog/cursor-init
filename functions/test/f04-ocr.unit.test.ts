import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { handlerFor } from "../src/p2/registry"
import { aggregateClassification, isCompleteLegacyOcrJob, OCR_JOB_TYPE } from "../src/p2/ocrJob"
import {
  DeterministicLocalOcrEngine,
  LOCAL_OCR_PROVIDER,
  OcrTimeoutError,
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
  it("the local stub returns the UTF-8 text of a text document, and the same bytes twice", async () => {
    const engine = new DeterministicLocalOcrEngine()
    const bytes = Buffer.from(TEXT, "utf8")
    const first = await engine.extract({ bytes, mimeType: "text/plain" })
    const second = await engine.extract({ bytes, mimeType: "text/plain" })
    expect(first).toEqual(second)
    expect(first).toEqual({ text: TEXT, confidence: 1, lowConfidence: false, provider: LOCAL_OCR_PROVIDER })
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
