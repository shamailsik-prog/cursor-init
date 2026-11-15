import { describe, expect, it } from "vitest"
import { detectionView } from "@/platform/p1/piiText"
import {
  OBSERVABILITY_FIELDS,
  REDACTED,
  mintDatedId,
  mintFirestoreId,
  mintHyphenatedId,
  mintMatterSerial,
  mintUlid,
  mintUuid,
  normalizeFieldKey,
  redactForObservability,
} from "@/platform/observability"

const firm = mintUuid()

/**
 * Q15a: the central redaction layer. Operational ids, codes and counts may pass.
 * Secrets, tokens, credentials, PII and client or matter content may not, including
 * when nested, carried on an error, or written with Unicode look-alikes.
 */

const allowed = new Set(OBSERVABILITY_FIELDS.map((field) => normalizeFieldKey(field)))

function dumped(value: unknown): string {
  return JSON.stringify(redactForObservability(value))
}

function expectAbsent(value: unknown, ...secrets: string[]): void {
  const text = dumped(value)
  for (const secret of secrets) {
    expect(text).not.toContain(secret)
  }
}

const cnic = "35202" + "-1234567-" + "1"
const cnicDigits = "35202" + "1234567" + "1"
const phone = "0300" + "1234567"
const email = "person" + "@" + "example.com"
const password = "hun" + "ter2"
const token = "tok" + "fixture"
const apiKey = "sk-" + "abcdefghijklmnopqrstuvwxyz"
const address = "House 12, Street 4, Lahore"
const personName = "Muhammad Ali"
const pleading = "IN THE COURT OF the learned counsel SECRET_PLEADING"
const draft = "DRAFT_BODY the plaintiff respectfully submits"
const message = "CLIENT_MESSAGE please call me back"
const note = "MATTER_NOTE do not file this version"
const bearer = "Bearer " + "fixture-token-value"
const cookie = "session=" + "fixture-cookie-value"

describe("Q15a redaction allowlist", () => {
  it("keeps minted ids, operational codes and counts", () => {
    const matter = mintUuid()
    const document = mintFirestoreId()
    const job = mintHyphenatedId("job", "123")
    const trace = mintUuid()
    expect(job?.text).toBe("job-123")
    expect(
      redactForObservability({
        firmId: firm,
        matterId: matter,
        documentId: document,
        jobId: job,
        event: "job_done",
        code: "not_minimised",
        reason: "lease_lost",
        outcome: "ok",
        status: "dead_lettered",
        classification: "privileged",
        service: "p2",
        durationMs: 42,
        count: 3,
        attempt: 1,
        statusCode: 200,
        ok: true,
        traceId: trace,
      }),
    ).toEqual({
      firmId: firm.text,
      matterId: matter.text,
      documentId: document.text,
      jobId: job?.text,
      event: "job_done",
      code: "not_minimised",
      reason: "lease_lost",
      outcome: "ok",
      status: "dead_lettered",
      classification: "privileged",
      service: "p2",
      durationMs: 42,
      count: 3,
      attempt: 1,
      statusCode: 200,
      ok: true,
      traceId: trace.text,
    })
  })

  it("does not allowlist secret, credential, PII or content field names", () => {
    const banned = [
      "password",
      "passwd",
      "secret",
      "token",
      "apikey",
      "xapikey",
      "authorization",
      "authorisation",
      "proxyauthorization",
      "cookie",
      "setcookie",
      "name",
      "fullname",
      "clientname",
      "partyname",
      "cnic",
      "nic",
      "phone",
      "mobile",
      "email",
      "address",
      "documenttext",
      "draft",
      "drafttext",
      "message",
      "messages",
      "note",
      "notes",
      "body",
      "content",
      "text",
      "stack",
      "prompt",
    ]
    for (const key of banned) expect(allowed.has(key)).toBe(false)
  })
})

describe("Q15a redaction categories", () => {
  it("redacts secrets", () => {
    expectAbsent({ secret: password, firmId: "firm_1" }, password)
    expectAbsent({ code: "secret=" + password }, password)
  })

  it("redacts tokens", () => {
    expectAbsent({ token, accessToken: token, firmId: "firm_1" }, token)
    expectAbsent({ code: bearer }, "fixture-token-value")
  })

  it("redacts API keys", () => {
    expectAbsent({ apiKey, api_key: apiKey, "X-Api-Key": apiKey }, apiKey)
    expectAbsent({ code: apiKey }, apiKey)
  })

  it("redacts passwords", () => {
    expectAbsent({ password, passwd: password, pwd: password }, password)
    expectAbsent({ code: "password=" + password }, password)
  })

  it("redacts auth headers", () => {
    expectAbsent(
      {
        authorization: bearer,
        authorisation: bearer,
        "proxy-authorization": bearer,
        headers: { Authorization: bearer },
      },
      "fixture-token-value",
    )
  })

  it("redacts cookies", () => {
    expectAbsent({ cookie, "set-cookie": cookie, headers: { Cookie: cookie } }, "fixture-cookie-value")
  })

  it("redacts names", () => {
    expectAbsent(
      { name: personName, fullName: personName, clientName: personName, partyName: personName },
      personName,
    )
    expectAbsent({ firmId: personName }, personName)
  })

  it("redacts CNICs", () => {
    expectAbsent({ cnic, nic: cnicDigits }, cnic, cnicDigits)
    expectAbsent({ code: cnic }, cnic)
    expectAbsent({ code: cnicDigits }, cnicDigits)
    expectAbsent({ count: Number(cnicDigits) }, cnicDigits)
  })

  it("redacts phone numbers", () => {
    expectAbsent({ phone, mobile: "+92" + "300" + "1234567" }, phone, "300" + "1234567")
    expectAbsent({ code: phone }, phone)
  })

  it("redacts email addresses", () => {
    expectAbsent({ email, mail: email }, email)
    expectAbsent({ reason: "notify " + email }, email)
  })

  it("redacts addresses", () => {
    expectAbsent({ address, residentialAddress: address }, address)
    expect(redactForObservability({ reason: address })).toEqual({ reason: REDACTED })
  })

  it("redacts document text", () => {
    expectAbsent({ documentText: pleading, text: pleading, body: pleading, content: pleading }, "SECRET_PLEADING")
  })

  it("redacts drafts", () => {
    expectAbsent({ draft, draftText: draft }, "DRAFT_BODY")
  })

  it("redacts messages", () => {
    expectAbsent({ message, messages: [message] }, "CLIENT_MESSAGE")
  })

  it("redacts notes", () => {
    expectAbsent({ note, notes: [note] }, "MATTER_NOTE")
  })
})

describe("Q15a redaction of nested values, errors and Unicode", () => {
  it("redacts secrets nested in objects and arrays", () => {
    expectAbsent(
      {
        firmId: "firm_1",
        context: {
          user: {
            email,
            profile: { address, name: personName, cnic },
          },
          documentText: pleading,
          notes: [{ note, phone }],
        },
        items: [{ password }, message],
      },
      email,
      address,
      personName,
      cnic,
      "SECRET_PLEADING",
      "MATTER_NOTE",
      phone,
      password,
      "CLIENT_MESSAGE",
    )
    expect(redactForObservability({ firmId: firm, context: { email } })).toEqual({ firmId: firm.text })
    expectAbsent({ firmId: { email, note } }, email, note)
    expect(redactForObservability({ firmId: firm, message: email, stack: "at " + note })).toEqual({
      firmId: firm.text,
    })
    const disguised = { name: "Ayesha_" + "Khan", message: email, firmId: firm }
    expect(redactForObservability(disguised)).toEqual({ firmId: firm.text })
  })

  it("redacts error messages and stack traces", () => {
    const marker = "STACK_MARKER_" + "Q15A"
    const err = new Error("password=" + password + " " + email + " " + cnic)
    err.stack = `${err.stack ?? ""}\n    at ${marker}`
    ;(err as Error & { email?: string }).email = email
    const cause = new Error(note)
    ;(err as Error & { cause?: unknown }).cause = cause
    expectAbsent(err, password, email, cnic, marker, note)
    expectAbsent({ message: err.message, stack: err.stack, cause }, password, email, cnic, marker, note)
    expectAbsent({ code: err.message }, password, email, cnic)
    const redacted = redactForObservability(err) as { errorName?: string }
    expect(redacted.errorName).toBe("Error")
  })

  it("redacts a thrown error whose message is only on the stack", () => {
    const marker = "STACK_ONLY_" + "Q15A"
    const err = new Error("boom")
    err.stack = `Error: boom\n    at read (${marker})`
    expectAbsent({ failure: err, stack: err.stack }, marker)
  })

  it("redacts Unicode and obfuscated keys and values", () => {
    const fullwidthPassword = "ｐａｓｓｗｏｒｄ"
    const cyrillicPassword = "p\u0430ssword"
    const fullwidthCnic = "３５２０２－１２３４５６７－１"
    const urduPhone = "۰۳۰۰۱۲۳۴۵۶۷"
    expect(detectionView(fullwidthCnic).text).toBe(cnic)
    expect(detectionView(urduPhone).text).toBe(phone)
    expectAbsent(
      {
        [fullwidthPassword]: password,
        [cyrillicPassword]: password,
        ["api\u200bkey"]: apiKey,
        ["e\u200bmail"]: email,
        ["n\u0430me"]: personName,
        ["c\u200bnic"]: cnic,
        ["a\u200bd\u200bdress"]: address,
      },
      password,
      apiKey,
      email,
      personName,
      cnic,
      address,
    )
    const brokenEmail = "per" + "\u200b" + "son@" + "example.com"
    expectAbsent({ code: fullwidthCnic }, fullwidthCnic, cnic)
    expectAbsent({ code: urduPhone }, urduPhone, phone)
    expectAbsent({ code: brokenEmail }, brokenEmail, email)
    expectAbsent({ ["p\u0430ss" + "word"]: password }, password)
  })

  it("does not follow a cyclic object", () => {
    const record: Record<string, unknown> = { firmId: firm, email }
    record.self = record
    expectAbsent(record, email)
    expect(redactForObservability(record)).toEqual({ firmId: firm.text })
  })
})

describe("Q15a fail-closed value shapes", () => {
  const keep = (field: string, value: string) => {
    expect(redactForObservability({ [field]: value })).toEqual({ [field]: value })
  }
  const drop = (field: string, value: string) => {
    const out = redactForObservability({ [field]: value }) as Record<string, unknown>
    expect(out[field]).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain(value)
  }

  it("keeps a 19-character operational token and six digits", () => {
    keep("code", "abcdefghijklmnopqrs")
    keep("code", "ab123456")
    keep("code", "OVERRIDE_FORBIDDEN")
    keep("reason", "matter_event_without_matter")
  })

  it("redacts a seventh digit in a non-id field", () => {
    drop("code", "ab1234567")
    drop("reason", "123456789")
  })

  it("redacts a 20-character non-id string by length", () => {
    drop("code", "abcdefghijklmnopqrst")
    drop("firmId", "abcdefghijklmnopqrst")
    keep("code", "a_" + "b".repeat(38))
    drop("code", "a_" + "b".repeat(39))
  })

  it("redacts a non-id value that is not lower or upper snake", () => {
    drop("code", "Not_Ok")
    drop("code", "ab/cd")
    drop("code", "pwd:hunter2")
    drop("reason", "token:abc123")
    drop("code", "access_token.abcdef")
    drop("reason", "jd.at.gmail.com")
    drop("status", "ayesha.khan")
    drop("event", "job.done")
    keep("code", "hunter2")
  })

  it("redacts any run of 10 or more digits", () => {
    drop("code", "ab1234567890")
    drop("code", "1234567890")
    drop("firmId", "id1234567890")
  })

  it("redacts a 13-digit CNIC after separators are stripped", () => {
    const underscored = "42101" + "_1234567_" + "1"
    const colon = "42101" + ":1234567:" + "1"
    const embedded = "user" + "4210112345671"
    const inId = "cnic" + "42101_1234567_1"
    drop("code", underscored)
    drop("code", colon)
    drop("code", embedded)
    drop("firmId", inId)
    expect(JSON.stringify(redactForObservability({ code: underscored }))).not.toContain("4210112345671")
  })

  it("redacts Pakistani mobiles after separators are stripped", () => {
    drop("code", "92-300-1234567")
    drop("code", "0300-123-4567")
    drop("code", "3001234567")
    drop("firmId", "tel0_300_1234567")
  })

  it("redacts secret prefixes that would otherwise be short tokens", () => {
    drop("code", "aiza" + "shortkey12")
    drop("code", "akia" + "examplekey1")
    drop("code", "github_pat_" + "abc")
    drop("code", "whsec_" + "abcdef")
    drop("code", "sk-" + "shortkey")
    drop("code", "eyj" + "hbciabcdef")
    drop("code", "basic_" + "shortcred")
  })

  it("redacts a 64-hex string, an AWS secret, a Basic credential and JWT segments", () => {
    const hex = "0123456789abcdef".repeat(4)
    const awsSecret = "wJalr" + "XUtnFEMI" + "/K7MDENG" + "/bPxRfiCY" + "EXAMPLEKEY"
    const basic = "Basic " + "dXNlcjpw"
    const header = "eyJ" + "hbGciOiJub25lIn0"
    const payload = "eyJ" + "ImEiOjF9abcd"
    const signature = "c2ln" + "YXR1cmVhYmNkZWZnaA"
    drop("code", hex)
    drop("reason", awsSecret)
    drop("code", basic)
    drop("code", header)
    drop("reason", payload)
    drop("status", signature)
    expect(awsSecret.length).toBeGreaterThanOrEqual(20)
    expect(hex).toHaveLength(64)
  })

  it("redacts a string UUID even when it contains a 10-digit run", () => {
    drop("traceId", "a1b2c3d4-e5f6-4789-8abc-1111111111ab")
  })

  it("redacts an id that does not match an id shape", () => {
    drop("firmId", "1firm")
    drop("matterId", "bad id")
    drop("firmId", "akia" + "examplekey1")
    drop("firmId", "f" + "a".repeat(63))
    drop("firmId", "f" + "a".repeat(64))
  })

  it("keeps an error class name and replaces any other name", () => {
    const typed = new Error("boom")
    typed.name = "TypeError"
    expect(redactForObservability(typed)).toMatchObject({ errorName: "TypeError" })
    const named = new Error("boom")
    named.name = "Ayesha_Khan_" + "4210112345671"
    const out = redactForObservability(named) as { errorName?: string }
    expect(out.errorName).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain("Ayesha")
    expect(JSON.stringify(out)).not.toContain("4210112345671")
    const lower = new Error("boom")
    lower.name = "error"
    expect((redactForObservability(lower) as { errorName?: string }).errorName).toBe(REDACTED)
  })

  it("drops metric values outside the magnitude and decimal bounds", () => {
    expect(redactForObservability({ value: 12 })).toEqual({ value: 12 })
    expect(redactForObservability({ value: 1.5 })).toEqual({ value: 1.5 })
    expect(redactForObservability({ value: 1_000_000 })).toEqual({ value: 1_000_000 })
    expect(redactForObservability({ value: 1_000_001 })).toEqual({})
    expect(redactForObservability({ value: 1.2345 })).toEqual({})
    expect(redactForObservability({ value: 1e-7 })).toEqual({})
    const disguised = 4210112345.671
    expect(JSON.stringify(redactForObservability({ value: disguised }))).not.toContain("4210112345")
  })

  it("keeps a small integer error code and drops an identifier-sized one", () => {
    const small = new Error("boom")
    ;(small as Error & { code: number }).code = 0
    expect(redactForObservability(small)).toMatchObject({ errorName: "Error", errorCode: 0 })
    const top = new Error("boom")
    ;(top as Error & { code: number }).code = 16
    expect(redactForObservability(top)).toMatchObject({ errorCode: 16 })
    const over = new Error("boom")
    ;(over as Error & { code: number }).code = 17
    expect((redactForObservability(over) as { errorCode?: unknown }).errorCode).toBeUndefined()
    const negative = new Error("boom")
    ;(negative as Error & { code: number }).code = -1
    expect((redactForObservability(negative) as { errorCode?: unknown }).errorCode).toBeUndefined()
    const named = new Error("boom")
    ;(named as Error & { code: string }).code = "grpc_3"
    expect(redactForObservability(named)).toMatchObject({ errorCode: "grpc_3" })
    const shaped = new Error("boom")
    ;(shaped as Error & { code: string }).code = "Not_Ok"
    expect((redactForObservability(shaped) as { errorCode?: unknown }).errorCode).toBeUndefined()
    const huge = new Error("boom")
    ;(huge as Error & { code: number }).code = Number("42101" + "1234567" + "1")
    expect(JSON.stringify(redactForObservability(huge))).not.toContain("4210112345671")
  })

  it("keeps bounded counts and drops a 10-digit count, a non-boolean ok and a root array", () => {
    expect(redactForObservability({ count: 999_999_999, durationMs: 86_400_000, attempt: 100, statusCode: 599 })).toEqual({
      count: 999_999_999,
      durationMs: 86_400_000,
      attempt: 100,
      statusCode: 599,
    })
    expect(redactForObservability({ count: -1 })).toEqual({})
    expect(redactForObservability({ count: 1.5 })).toEqual({})
    expect(redactForObservability({ value: Number.NaN })).toEqual({})
    expect(redactForObservability({ count: 1_000_000_000 })).toEqual({})
    expect(redactForObservability({ count: 1_000_000_001 })).toEqual({})
    expect(redactForObservability({ durationMs: 86_400_001 })).toEqual({})
    expect(redactForObservability({ durationMs: -1 })).toEqual({})
    expect(redactForObservability({ attempt: 0 })).toEqual({ attempt: 0 })
    expect(redactForObservability({ attempt: -1 })).toEqual({})
    expect(redactForObservability({ attempt: 101 })).toEqual({})
    expect(redactForObservability({ statusCode: 0 })).toEqual({ statusCode: 0 })
    expect(redactForObservability({ statusCode: -1 })).toEqual({})
    expect(redactForObservability({ statusCode: 600 })).toEqual({})
    expect(redactForObservability({ ok: true })).toEqual({ ok: true })
    expect(redactForObservability({ ok: "true" })).toEqual({})
    expect(redactForObservability({ code: true })).toEqual({})
    expect(redactForObservability(null)).toBeUndefined()
    expect(redactForObservability(["secret"])).toBe(REDACTED)
    expect(redactForObservability("pwd:hunter2")).toBe(REDACTED)
    expect(redactForObservability("not_minimised")).toBe("not_minimised")
    expect(redactForObservability({ count: "42101-1234567-1", firmId: firm })).toEqual({ firmId: firm.text })
    expect(redactForObservability({ value: "12" })).toEqual({})
  })

  it("redacts an embedded CNIC, mobile, 0092 prefix or landline", () => {
    const cnic = "c1-42101-1234567-1"
    const mobile = "v1-0300-1234567"
    const intl = "0092-300-1234567"
    const land = "021-34567890"
    for (const field of ["code", "reason", "outcome", "status", "classification"]) {
      drop(field, cnic)
      drop(field, mobile)
      drop(field, intl)
      drop(field, land)
    }
    drop("firmId", cnic)
    drop("matterId", "matter-7-42101-1234567-1")
    drop("documentId", mobile)
    drop("jobId", "n" + intl)
    drop("firmId", "line" + land)
  })

  it("redacts token prefixes in an id, including a bare Basic token and a JWT signature", () => {
    const basic = "dXNl" + "cjpwYXNz" + "d29yZA"
    const signature = "SflKxwRJ" + "SMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    drop("firmId", "ghp_" + "abcdefgh")
    drop("firmId", "gho_" + "abcdefgh")
    drop("firmId", "glpat-" + "abcdefgh")
    drop("actorId", "sk_live_" + "abcdefgh")
    drop("actorId", "rk_live_" + "abcdefgh")
    drop("requestId", "xoxb-" + "abcdefgh")
    drop("requestId", "xoxp-" + "abcdefgh")
    drop("firmId", "ASIA" + "IOSFODNN7EXAMPLE")
    drop("firmId", "AKIA" + "IOSFODNN7EXAMPLE")
    drop("spanId", basic)
    drop("spanId", "Basic " + basic)
    drop("parentSpanId", signature)
    expect(basic).toMatch(/[a-z]/)
    expect(basic).toMatch(/[A-Z]/)
    expect(signature).toMatch(/[a-z]/)
    expect(signature).toMatch(/[A-Z]/)
  })

  it("redacts a string UUID and a dashed id", () => {
    drop("traceId", "A1B2C3D4-E5F6-4789-8ABC-1111111111AB")
    drop("firmId", "1234-5678")
    drop("traceId", "ab/cd")
    drop("traceId", "ab.cd")
    drop("traceId", "ab:cd")
    drop("traceId", "ab@cd")
  })

  it("does not take errorName or errorCode from caller fields", () => {
    const leaked = "AyeshaKhan" + "4210112345671"
    const key = "AKIA" + "IOSFODNN7EXAMPLE"
    const google = "AIzaSy" + "ShortKey12"
    expect(redactForObservability({ errorName: leaked, errorCode: "grpc_3", firmId: firm })).toEqual({
      firmId: firm.text,
    })
    expect(redactForObservability({ error_name: leaked, error_code: key, code: "not_minimised" })).toEqual({
      code: "not_minimised",
    })
    const ayesha = new Error("boom")
    ayesha.name = leaked
    expect((redactForObservability(ayesha) as { errorName?: string }).errorName).toBe(REDACTED)
    const akia = new Error("boom")
    akia.name = key
    expect((redactForObservability(akia) as { errorName?: string }).errorName).toBe(REDACTED)
    const aiza = new Error("boom")
    aiza.name = google
    expect((redactForObservability(aiza) as { errorName?: string }).errorName).toBe(REDACTED)
    expect(JSON.stringify(redactForObservability(ayesha))).not.toContain("Ayesha")
    expect(JSON.stringify(redactForObservability(akia))).not.toContain("AKIA")
    expect(JSON.stringify(redactForObservability(aiza))).not.toContain("AIza")
  })

  it("redacts a non-uuid id with more than eight digits", () => {
    const cnicWide = "x42101---1234567---1"
    const cnicPairs = "c42101--1234567--1"
    const iban = "PK36-SCBL-0000-0011-2345-6702"
    drop("firmId", "l021-3456-7890")
    drop("firmId", "l92-21-34567890")
    drop("firmId", "l0092-21-34567890")
    drop("firmId", "l051-2345678")
    drop("matterId", iban)
    drop("documentId", cnicWide)
    drop("jobId", cnicPairs)
    drop("actorId", "id-4210-1123-4567-1")
    drop("requestId", "m0300_123_45_67")
    drop("firmId", "ab123456789")
    drop("firmId", "ab12345678")
    drop("firmId", "firm_1")
    expect(JSON.stringify(redactForObservability({ matterId: iban }))).not.toContain("SCBL")
  })

  it("redacts a string that only matches a 20-character auto-id shape", () => {
    drop("firmId", "AbCdEfGhIjKlMnOpQrSt")
    drop("matterId", "AbCdEf12345678GhJklm")
    drop("actorId", "AbCdEf123456789GhJkl")
    drop("firmId", "ASIA" + "IOSFODNN7EXAMPLE")
    drop("firmId", "MuhammadAliKhanAbbas")
  })

  it("redacts secret prefixes at a boundary and refused segments in an id", () => {
    drop("firmId", "xghp_" + "abcdefgh")
    drop("firmId", "req_ghp_" + "abcdefgh")
    drop("firmId", "req-ghp_" + "abcdefgh")
    drop("actorId", "KEY_" + "AKIA" + "IOSFODNN7EXAMPLE")
    drop("actorId", "X_" + "ASIA" + "IOSFODNN7EXAMPLE")
    drop("requestId", "sess-" + "abcdefgh")
    drop("requestId", "passwd_hunter2")
    drop("documentId", "house-12-street-5")
    drop("spanId", "PK36-SCBL-0000-0011-2345-6702")
    drop("firmId", "ghs_" + "abcdefgh")
    drop("firmId", "ghu_" + "abcdefgh")
    drop("firmId", "npm_" + "abcdefgh")
    drop("actorId", "sk_test_" + "abcdefgh")
    drop("actorId", "rk_test_" + "abcdefgh")
    drop("actorId", "pk_live_" + "abcdefgh")
    drop("actorId", "pk_test_" + "abcdefgh")
    drop("requestId", "xoxa-" + "abcdefgh")
    drop("requestId", "xoxr-" + "abcdefgh")
    drop("requestId", "xoxs-" + "abcdefgh")
    drop("jobId", "key-" + "abcdefgh")
    for (const segment of ["password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "bearer", "authorization", "credential"]) {
      drop("code", segment + "_hunter2")
    }
    keep("code", "hunter2")
  })

  it("rejects kebab-case non-id values", () => {
    drop("code", "not-minimised")
    drop("event", "job-done")
    keep("code", "not_minimised")
  })

  it("keeps only a short error class ending in Error or Exception", () => {
    const caps = new Error("boom")
    caps.name = "TYPEERROR"
    expect((redactForObservability(caps) as { errorName?: string }).errorName).toBe(REDACTED)
    const plain = new Error("boom")
    plain.name = "AyeshaKhan"
    expect((redactForObservability(plain) as { errorName?: string }).errorName).toBe(REDACTED)
    const long = new Error("boom")
    long.name = "A" + "b".repeat(35) + "Error"
    expect(long.name).toHaveLength(41)
    expect((redactForObservability(long) as { errorName?: string }).errorName).toBe(REDACTED)
    const ok = new Error("boom")
    ok.name = "A" + "b".repeat(34) + "Error"
    expect(ok.name).toHaveLength(40)
    expect((redactForObservability(ok) as { errorName?: string }).errorName).toBe(REDACTED)
    const custom = new Error("boom")
    custom.name = "HttpException"
    expect((redactForObservability(custom) as { errorName?: string }).errorName).toBe(REDACTED)
  })

  it("redacts a top-level bigint", () => {
    const cnic = BigInt("42101" + "1234567" + "1")
    expect(redactForObservability(cnic)).toBe(REDACTED)
    expect(String(redactForObservability(cnic))).not.toContain("4210112345671")
    expect(redactForObservability({ count: cnic, firmId: firm })).toEqual({ firmId: firm.text })
  })

  it("folds case, separators and confusable letters in field names", () => {
    expect(redactForObservability({ Code: "not_minimised" })).toEqual({ code: "not_minimised" })
    expect(redactForObservability({ firm_id: firm })).toEqual({ firmId: firm.text })
    expect(redactForObservability({ "FIRM-ID": firm })).toEqual({ firmId: firm.text })
    expect(redactForObservability({ ["f\u0456rmId"]: firm })).toEqual({ firmId: firm.text })
  })

  it("Q15b L2 redacts shape-kept PII on id fields", () => {
    const phoneUuid = "03001234-5670-4000-8000-000000000000"
    const cnicUuid = "42101123-4567-4100-8000-000000000000"
    const lookalike = "O3OO" + "1234567"
    const left = "p0300123"
    const right = "p4567"
    const land = "tel" + "34567890"
    const dob = "dob" + "19850312"
    const passport = "AB" + "1234567"
    const name = "MuhammadAliKhanAbbas"
    for (const value of [phoneUuid, cnicUuid, lookalike, left, right, land, dob, passport, name]) {
      drop("firmId", value)
    }
    const split = redactForObservability({ firmId: left, matterId: right })
    const text = JSON.stringify(split)
    expect(text).not.toContain("0300123")
    expect(text).not.toContain("4567")
    expect(text).not.toContain(lookalike)
  })

  it("Q15b L2 redacts a personal name dressed as an error class", () => {
    const named = new Error("boom")
    named.name = "MuhammadAliError"
    const out = redactForObservability(named) as { errorName?: string }
    expect(out.errorName).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain("Muhammad")
  })

  it("Q15b L3 keeps repo token codes by exact membership", () => {
    for (const code of [
      "malformed_token",
      "missing_token",
      "invalid_token",
      "token_expired",
      "token_revoked",
      "AUTHORIZATION_FAILED",
      "pwd_reset",
    ]) {
      keep("code", code)
      keep("reason", code)
    }
    drop("code", "token_" + "hunter2")
    drop("code", "password_reset")
    drop("reason", "not_a_token_code")
    drop("code", "pwd_reset_" + "hunter2")
    drop("reason", "pwd_reset_" + "hunter2")
  })

  it("Q15b L4 keeps URIError, tokenizer_failed and secretary_absent", () => {
    const uri = new Error("boom")
    uri.name = "URIError"
    expect((redactForObservability(uri) as { errorName?: string }).errorName).toBe("URIError")
    keep("code", "tokenizer_failed")
    keep("reason", "secretary_absent")
    keep("status", "tokenizer_failed")
    keep("outcome", "secretary_absent")
    keep("code", "tokenizer_ok")
    keep("reason", "secretary_present")
    keep("status", "tokenizer_ok")
    keep("outcome", "secretary_present")
  })

  it("Q15b L5 anchors AKIA, ASIA, AIZA and sk_live at a token boundary", () => {
    keep("code", "XX" + "AKIA" + "1234")
    keep("code", "notakia1234")
    drop("code", "KEY_" + "AKIA" + "1234")
    drop("code", "X_" + "ASIA" + "1234")
    drop("code", "x" + "ghp_" + "abcdefgh")
    drop("code", "AKIA" + "1234")
    drop("code", "AIZA" + "1234")
    drop("code", "sk_live_" + "abc")
    keep("code", "xx" + "sk_live_" + "abc")
    drop("code", "pre_" + "sk_live_" + "abc")
    keep("code", "task_live_sync")
    keep("code", "risk_live")
    keep("code", "disk_live_ok")
    keep("code", "ask_live")
    keep("code", "sk_liveabc")
  })

  it("Q15b L2 and L3 keep a minted id and redact the same text", () => {
    const uuid = mintUuid()
    const autoId = mintFirestoreId()
    const ulid = mintUlid()
    const trace = mintHyphenatedId("trace", "abc")
    const matter = mintMatterSerial(2026, 123)
    const dated = mintDatedId(2026, 11, 15, 1)
    expect(trace?.text).toBe("trace-abc")
    expect(matter?.text).toBe("MATTER_2026_000123")
    expect(dated?.text).toBe("mat_2026_11_15_001")
    expect(autoId.text).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(ulid?.text).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(uuid.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(matter!.text.replace(/\D/g, "").length).toBeGreaterThan(8)
    expect(
      redactForObservability({
        traceId: uuid,
        firmId: autoId,
        spanId: ulid,
        requestId: trace,
        matterId: matter,
        documentId: dated,
      }),
    ).toEqual({
      traceId: uuid.text,
      firmId: autoId.text,
      spanId: ulid?.text,
      requestId: trace?.text,
      matterId: matter?.text,
      documentId: dated?.text,
    })
    drop("traceId", uuid.text)
    drop("firmId", autoId.text)
    drop("spanId", ulid!.text)
    drop("requestId", "trace-abc")
    drop("jobId", "job-123")
    drop("matterId", "MATTER_2026_000123")
    drop("documentId", "mat_2026_11_15_001")
    drop("firmId", "malformed_token")
    expect(mintHyphenatedId("trace", "03001234567")).toBeUndefined()
    expect(mintHyphenatedId("job", "Muhammad")).toBeUndefined()
    expect(mintHyphenatedId("trace", "akia12")).toBeUndefined()
    expect(mintHyphenatedId("job", "token")).toBeUndefined()
    expect(mintMatterSerial(1999, 1)).toBeUndefined()
    expect(mintMatterSerial(2026, 1_000_000)).toBeUndefined()
    expect(mintDatedId(2026, 13, 1, 1)).toBeUndefined()
    expect(mintDatedId(2026, 11, 15, 1000)).toBeUndefined()
    expect(mintUlid(-1)).toBeUndefined()
    expect(mintHyphenatedId("job", "123")?.text).toBe("job-123")
    expect(mintHyphenatedId("job", "muhammad")).toBeUndefined()
    expect(mintHyphenatedId("job", "hunter2")).toBeUndefined()
    expect(mintHyphenatedId("job", "ayesha")).toBeUndefined()
    expect(mintHyphenatedId("trace", "1234")).toBeUndefined()
    expect(mintHyphenatedId("trace", "abcdefghi")).toBeUndefined()
    expect(mintHyphenatedId("firm" as "trace", "abc")).toBeUndefined()
    expect(mintDatedId(2026, 2, 31, 1)).toBeUndefined()
    expect(mintDatedId(2026, 2, 29, 1)).toBeUndefined()
    expect(mintDatedId(2024, 2, 29, 1)?.text).toBe("mat_2024_02_29_001")
    expect(mintDatedId(2026, 4, 31, 1)).toBeUndefined()
    expect(mintDatedId(2026, 1, 32, 1)).toBeUndefined()
    expect(mintDatedId(2026, 1, 0, 1)).toBeUndefined()
  })


  it("Q15b R2 keeps the repo error classes and redacts a personal name", () => {
    const REPO_ERROR_CLASSES = [
  "APIConnectionError",
  "ApiError",
  "AuditAppendConflictError",
  "AuthError",
  "AuthorityUnavailableError",
  "BatchError",
  "CallerFirmRequiredError",
  "CitationError",
  "CommittedEffectError",
  "CommitteeScopeError",
  "ConfigurationError",
  "ContractError",
  "CorpusUnavailableError",
  "CourtOpsAckIdError",
  "CourtOpsAckRefusedError",
  "CourtOpsItemNotFoundError",
  "CursorError",
  "DeployContractError",
  "DocumentMalformedError",
  "DocumentObjectAlreadyExistsError",
  "DocumentObjectConfigurationError",
  "DocumentObjectStoreError",
  "DraftChangedError",
  "DraftCharsetError",
  "DraftSizeError",
  "DraftTemplateAnalyticsIdError",
  "DraftTemplateAnalyticsRefusedError",
  "EnvelopeError",
  "ExplodingRowError",
  "FeatureDisabledError",
  "FirmScopedCursorError",
  "FirmScopedUpdateError",
  "FollowUpResolveRefusedError",
  "HarvesterContractError",
  "HttpError",
  "IdempotencyError",
  "IdempotencyFenceError",
  "InsecureDevAuthContextError",
  "JobError",
  "LeaseLostError",
  "ManifestError",
  "MatterClosedError",
  "MatterShapeError",
  "MembershipAssignmentError",
  "OcrAdmissionError",
  "OcrTimeoutError",
  "PDFDownloadError",
  "PDFExtractionError",
  "PackageAlreadyDecidedError",
  "PeriodRangeError",
  "PersistenceConfigurationError",
  "PgTargetNotCleanError",
  "ProviderKeyInRuntimeError",
  "PublicError",
  "PublicationError",
  "QueryTextError",
  "RateLimitedError",
  "ReconcileError",
  "RetentionConfigError",
  "ScheduledRunsFailedError",
  "SearchIndexMalformedError",
  "SectionHistoryInconsistentError",
  "ServiceAuthError",
  "SurfaceError",
  "TokenRejectedError",
  "ToolContractError",
  "UnregisteredJobTypeError",
  "_RecordSpecificError",
  "P1EmbeddingRequestError",
  "P1EmbeddingTransportError",
  "P1PreCallDeadlineError",
  "P1TransportError",
]
    expect(REPO_ERROR_CLASSES).toHaveLength(72)
    for (const name of REPO_ERROR_CLASSES) {
      const err = new Error("boom")
      err.name = name
      expect((redactForObservability(err) as { errorName?: string }).errorName, name).toBe(name)
    }
    for (const name of ["MuhammadError", "KhanError", "AyeshaException", "MuhammadAliError"]) {
      const err = new Error("boom")
      err.name = name
      const out = redactForObservability(err) as { errorName?: string }
      expect(out.errorName, name).toBe(REDACTED)
      expect(JSON.stringify(out)).not.toContain(name.slice(0, name.startsWith("Ayesha") ? 6 : 4))
    }
  })

  it("does not keep a plain object that copies a minted id's text", () => {
    const phoneUuid = "03001234-5670-4000-8000-000000000000"
    const forged = { text: phoneUuid }
    const out = redactForObservability({ firmId: forged }) as { firmId?: unknown }
    expect(out.firmId).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain("03001234")
  })
})
