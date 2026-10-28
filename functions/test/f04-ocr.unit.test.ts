import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"
import { logger } from "firebase-functions"
import { handlerFor } from "../src/p2/registry"
import { adminDb } from "../src/admin"
import { aggregateClassification, isCompleteLegacyOcrJob, labelAtPublish, OCR_JOB_TYPE } from "../src/p2/ocrJob"
import { EMULATORS, uniq } from "./emu"
import {
  capOcrText,
  DeterministicLocalOcrEngine,
  LOCAL_OCR_PROVIDER,
  MAX_OCR_TEXT_BYTES,
  measureOcrText,
  OcrTimeoutError,
  isProdLikeOcrRuntime,
  resolveOcrEngine,
  withOcrTimeout,
} from "../src/p1/ocrEngine"
import { callP1Ocr, ocrTestSeam, ocrTextId } from "../src/p1/ocrCall"
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
    expect(out.truncated).toBe(true)
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

  it("FA-F04-006-001: the production-defined OCR engine bundle fails closed with host NODE_ENV and deploy profile unset", async () => {
    const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const repoRoot = path.resolve(functionsDir, "..")
    const outfile = path.join(functionsDir, "lib/.fa-f04-006-ocr-engine.cjs")
    await build({
      entryPoints: [path.join(functionsDir, "src/p1/ocrEngine.ts")],
      outfile,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": repoRoot },
      logLevel: "silent",
    })
    try {
      const bundleSrc = readFileSync(outfile, "utf8")
      expect(bundleSrc).not.toMatch(/process\.env\[["']NODE_ENV["']\]/)
      const script = `const { resolveOcrEngine } = require(${JSON.stringify(outfile)});
delete process.env.NODE_ENV;
delete process.env.SIKANDER_DEPLOY_PROFILE;
if (resolveOcrEngine({}) !== null) process.exit(2);`
      execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, NODE_ENV: undefined, SIKANDER_DEPLOY_PROFILE: undefined },
        stdio: "pipe",
      })
      const req = createRequire(import.meta.url)
      expect(req(outfile).resolveOcrEngine({})).toBeNull()
    } finally {
      rmSync(outfile, { force: true })
    }
  }, 60_000)

  it("FA-F04-008: measureOcrText reports truncation without dropping valid UTF-8", () => {
    const ch = "\u{FBAB}"
    const full = ch.repeat(400_000)
    const measured = measureOcrText(full)
    expect(measured.truncated).toBe(true)
    expect(Buffer.byteLength(measured.text, "utf8")).toBeLessThanOrEqual(MAX_OCR_TEXT_BYTES)
    expect(Buffer.from(measured.text, "utf8").toString("utf8")).toBe(measured.text)
    expect(measureOcrText(TEXT)).toEqual({ text: TEXT, truncated: false })
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

  it("FA-F04-009 O11: publish stamps audit and legacy rows with the label re-checked at publish, not the pre-OCR aggregate", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/p2/ocrJob.ts"), "utf8")
    const publishBlock = src.slice(src.indexOf('await ctx.runFenced("publish"'), src.indexOf("const storedText = await textRef.get()"))
    expect(publishBlock).toContain("published = await labelAtPublish(")
    expect(publishBlock).toMatch(/classification:\s*published/)
    expect(publishBlock).toMatch(/ocrClassification:\s*published/)
    expect(publishBlock).not.toMatch(/classification:\s*aggregate/)
    expect(publishBlock).not.toMatch(/ocrClassification:\s*aggregate/)
  })

  it("the stub module does not call a network or a real OCR binary", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/p1/ocrEngine.ts"), "utf8")
    expect(src).not.toMatch(/\bfetch\s*\(/)
    expect(src).not.toMatch(/from ["']https?/)
    expect(src).not.toMatch(/tesseract|vision|child_process/i)
  })
})

describe.skipIf(!EMULATORS)("FA-F04-008-001: ocr.admit reason text_truncated (emulator)", () => {
  const contentHash = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff01"

  afterEach(() => {
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
  })

  async function waitForAdmitAudit(
    target: string,
    reason: "text_truncated" | "ok"
  ): Promise<FirebaseFirestore.QuerySnapshot> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const snap = await adminDb().collection("audit_log").where("target", "==", target).get()
      if (
        snap.docs.some(
          (entry) => entry.get("action") === "ocr.admit" && entry.get("reason") === reason && entry.get("decision") === "allow"
        )
      ) {
        return snap
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return adminDb().collection("audit_log").where("target", "==", target).get()
  }

  it("FA-F04-008-001: admission audit uses reason text_truncated when UTF-8 cap applies", async () => {
    const firmId = uniq("f04008001-firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-F04-008-001", plan: "internal" })
    const documentId = uniq("f04008001-doc")
    const operationId = uniq("f04008001-op")
    const ch = "\u{FBAB}"
    const bytes = Buffer.from(ch.repeat(400_000), "utf8")

    const result = await callP1Ocr({
      firmId,
      actorId: "system",
      matterId: null,
      jobId: operationId,
      operationId,
      legacyJobId: uniq("f04008001-legacy"),
      documentId,
      contentHash,
      classification: "internal",
      sources: ["internal"],
      bytes,
      mimeType: "text/plain",
    })

    expect(result.outcome).toBe("ok")
    expect(result.truncated).toBe(true)

    const target = `ocr_texts/${ocrTextId(firmId, documentId, contentHash)}`
    const audits = await waitForAdmitAudit(target, "text_truncated")
    expect(
      audits.docs.some(
        (entry) =>
          entry.get("action") === "ocr.admit" && entry.get("reason") === "text_truncated" && entry.get("decision") === "allow"
      )
    ).toBe(true)
  })

  it("FA-F04-008-001-001: admission audit uses reason ok when UTF-8 cap does not apply", async () => {
    const firmId = uniq("f04008001001-firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-F04-008-001-001", plan: "internal" })
    const documentId = uniq("f04008001001-doc")
    const operationId = uniq("f04008001001-op")
    const bytes = Buffer.from(TEXT, "utf8")

    const result = await callP1Ocr({
      firmId,
      actorId: "system",
      matterId: null,
      jobId: operationId,
      operationId,
      legacyJobId: uniq("f04008001001-legacy"),
      documentId,
      contentHash: "b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff02",
      classification: "internal",
      sources: ["internal"],
      bytes,
      mimeType: "text/plain",
    })

    expect(result.outcome).toBe("ok")
    expect(result.truncated).toBe(false)

    const target = `ocr_texts/${ocrTextId(firmId, documentId, "b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff02")}`
    const audits = await waitForAdmitAudit(target, "ok")
    expect(
      audits.docs.some(
        (entry) => entry.get("action") === "ocr.admit" && entry.get("reason") === "ok" && entry.get("decision") === "allow"
      )
    ).toBe(true)
    expect(
      audits.docs.some(
        (entry) => entry.get("action") === "ocr.admit" && entry.get("reason") === "text_truncated"
      )
    ).toBe(false)
  })
})

describe.skipIf(!EMULATORS)("FA-F04-008-002: ocr.text_truncated structured log (emulator)", () => {
  const contentHash = "c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff03"

  afterEach(() => {
    delete ocrTestSeam.engine
    delete ocrTestSeam.timeoutMs
    vi.restoreAllMocks()
  })

  const loggedInfo = (spy: { mock: { calls: unknown[][] } }, message: string) =>
    spy.mock.calls.filter(([m]) => m === message).map(([, data]) => data)

  it("FA-F04-008-002: admission logs ocr.text_truncated with ids only when UTF-8 cap applies", async () => {
    const firmId = uniq("f04008002-firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-F04-008-002", plan: "internal" })
    const documentId = uniq("f04008002-doc")
    const operationId = uniq("f04008002-op")
    const legacyJobId = uniq("f04008002-legacy")
    const ch = "\u{FBAB}"
    const bytes = Buffer.from(ch.repeat(400_000), "utf8")
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined)

    const result = await callP1Ocr({
      firmId,
      actorId: "system",
      matterId: null,
      jobId: operationId,
      operationId,
      legacyJobId,
      documentId,
      contentHash,
      classification: "internal",
      sources: ["internal"],
      bytes,
      mimeType: "text/plain",
    })

    expect(result.outcome).toBe("ok")
    expect(result.truncated).toBe(true)
    expect(loggedInfo(info, "ocr.text_truncated")).toEqual([
      { firmId, operationId, documentId, legacyJobId },
    ])
    for (const payload of loggedInfo(info, "ocr.text_truncated")) {
      expect(payload).not.toHaveProperty("text")
      expect(Object.keys(payload as object).sort()).toEqual(["documentId", "firmId", "legacyJobId", "operationId"])
    }
  })

  it("FA-F04-008-002: admission does not log ocr.text_truncated when UTF-8 cap does not apply", async () => {
    const firmId = uniq("f04008002001-firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-F04-008-002-under", plan: "internal" })
    const documentId = uniq("f04008002001-doc")
    const operationId = uniq("f04008002001-op")
    const bytes = Buffer.from(TEXT, "utf8")
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined)

    const result = await callP1Ocr({
      firmId,
      actorId: "system",
      matterId: null,
      jobId: operationId,
      operationId,
      legacyJobId: uniq("f04008002001-legacy"),
      documentId,
      contentHash: "d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff04",
      classification: "internal",
      sources: ["internal"],
      bytes,
      mimeType: "text/plain",
    })

    expect(result.outcome).toBe("ok")
    expect(result.truncated).toBe(false)
    expect(loggedInfo(info, "ocr.text_truncated")).toEqual([])
  })
})

describe.skipIf(!EMULATORS)("FA-F04-009: labelAtPublish (emulator)", () => {
  async function seedLabelFixtures(documentClassification: string, matterClassification: string) {
    const firmId = uniq("f04-009-firm")
    const matterId = uniq("f04-009-matter")
    const documentId = uniq("f04-009-doc")
    await adminDb().collection("firms").doc(firmId).set({ name: "F04-009 Firm", plan: "internal" })
    await adminDb()
      .collection("matters")
      .doc(matterId)
      .set({ id: matterId, firmId, classification: matterClassification, title: "Matter", clientId: "c", courtId: "SHC" })
    await adminDb()
      .collection("documents")
      .doc(documentId)
      .set({
        firmId,
        matterId,
        classification: documentClassification,
        contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff01",
        objectBytesStatus: "available",
        storagePath: "path",
        mimeType: "text/plain",
      })
    return { firmId, matterId, documentId }
  }

  it("O4: a stricter document label applied after load is included at publish", async () => {
    const { firmId, matterId, documentId } = await seedLabelFixtures("internal", "internal")
    await adminDb().collection("documents").doc(documentId).update({ classification: "confidential" })
    const admitted = aggregateClassification(["internal"])
    expect(
      await adminDb().runTransaction((tx) => labelAtPublish(tx, firmId, matterId, documentId, admitted))
    ).toBe("confidential")
  })

  it("O6: a stricter matter label applied after load is included at publish", async () => {
    const { firmId, matterId, documentId } = await seedLabelFixtures("internal", "privileged")
    const admitted = aggregateClassification(["internal"])
    expect(
      await adminDb().runTransaction((tx) => labelAtPublish(tx, firmId, matterId, documentId, admitted))
    ).toBe("privileged")
  })

  it("a label lowered mid-job does not publish under the lower label", async () => {
    const { firmId, matterId, documentId } = await seedLabelFixtures("internal", "internal")
    const admitted = aggregateClassification(["confidential"])
    expect(
      await adminDb().runTransaction((tx) => labelAtPublish(tx, firmId, matterId, documentId, admitted))
    ).toBe("confidential")
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
