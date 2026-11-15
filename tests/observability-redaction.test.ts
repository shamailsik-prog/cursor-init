import { describe, expect, it } from "vitest"
import { detectionView } from "@/platform/p1/piiText"
import {
  OBSERVABILITY_FIELDS,
  REDACTED,
  normalizeFieldKey,
  redactForObservability,
} from "@/platform/observability"

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
  it("keeps operational ids, codes and counts", () => {
    expect(
      redactForObservability({
        firmId: "firm_1",
        matterId: "matter_1",
        documentId: "doc_1",
        jobId: "job_1",
        event: "job.done",
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
        traceId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({
      firmId: "firm_1",
      matterId: "matter_1",
      documentId: "doc_1",
      jobId: "job_1",
      event: "job.done",
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
      traceId: "11111111-1111-4111-8111-111111111111",
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
    expect(redactForObservability({ firmId: "firm_1", context: { email } })).toMatchObject({ firmId: "firm_1" })
    expectAbsent({ firmId: { email, note } }, email, note)
    expect(redactForObservability({ firmId: "firm_1", message: email, stack: "at " + note })).toMatchObject({
      firmId: "firm_1",
    })
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
    const record: Record<string, unknown> = { firmId: "firm_1", email }
    record.self = record
    expectAbsent(record, email)
    expect(redactForObservability(record)).toMatchObject({ firmId: "firm_1" })
  })
})
