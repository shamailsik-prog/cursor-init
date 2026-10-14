import { createHash, createHmac } from "node:crypto"

/**
 * In-process stand-in for an S3-compatible endpoint (R2 / MinIO semantics) used by the unit
 * tests of the R2 document object backend. It refuses unsigned requests and payload-hash
 * mismatches, honours `If-None-Match: *`, and records every request so a test can check the
 * wire format. The real-server proof is tests/fa-d16-001.document-vault-s3.e2e.test.ts (MinIO).
 */
export type RecordedS3Request = {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: Buffer
  /** How the caller handed over the body: "bytes" (length known up front), "none" or "other". */
  bodyKind: "bytes" | "none" | "other"
  /** The fetch `cache` option the caller passed (Next.js extends fetch with a data cache). */
  cache: RequestCache | undefined
}

export type FakeS3 = {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
  objects: Map<string, Buffer>
  requests: RecordedS3Request[]
  /** Every Response handed back to the caller, in order (to check that bodies are consumed). */
  responses: Response[]
  /** Next responses override the simulated server, first match wins; return undefined to pass. */
  intercept(fn: (req: RecordedS3Request) => Response | Promise<Response> | undefined): void
}

export function s3ErrorResponse(status: number, code: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>simulated</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } }
  )
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

export function createFakeS3(): FakeS3 {
  const objects = new Map<string, Buffer>()
  const requests: RecordedS3Request[] = []
  const responses: Response[] = []
  const interceptors: Array<(req: RecordedS3Request) => Response | Promise<Response> | undefined> = []

  async function fetchImpl(target: string, init: RequestInit): Promise<Response> {
    const response = await serve(target, init)
    responses.push(response)
    return response
  }

  async function serve(target: string, init: RequestInit): Promise<Response> {
    const request = new Request(target, init)
    const url = new URL(request.url)
    const body = Buffer.from(await request.arrayBuffer())
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    const recorded: RecordedS3Request = {
      method: request.method,
      url: request.url,
      path: url.pathname,
      headers,
      body,
      bodyKind: init.body == null ? "none" : init.body instanceof Uint8Array ? "bytes" : "other",
      cache: init.cache,
    }
    requests.push(recorded)
    for (const fn of interceptors) {
      const response = await fn(recorded)
      if (response) return response
    }
    if (!headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return s3ErrorResponse(403, "AccessDenied")
    if (headers["x-amz-content-sha256"] !== sha256Hex(body)) {
      return s3ErrorResponse(400, "XAmzContentSHA256Mismatch")
    }
    const objectPath = decodeURIComponent(url.pathname)
    switch (request.method) {
      case "PUT":
        if (headers["if-none-match"] === "*" && objects.has(objectPath)) {
          return s3ErrorResponse(412, "PreconditionFailed")
        }
        objects.set(objectPath, body)
        return new Response(null, { status: 200 })
      case "GET": {
        const stored = objects.get(objectPath)
        if (!stored) return s3ErrorResponse(404, "NoSuchKey")
        return new Response(new Uint8Array(stored), { status: 200 })
      }
      case "DELETE":
        objects.delete(objectPath)
        return new Response(null, { status: 204 })
      default:
        return s3ErrorResponse(405, "MethodNotAllowed")
    }
  }

  return {
    fetchImpl,
    objects,
    requests,
    responses,
    intercept(fn) {
      interceptors.push(fn)
    },
  }
}

/**
 * Independent AWS Signature Version 4 check (header auth, unsigned query), written from the
 * AWS spec rather than taken from the signing library, so a test can prove the backend's
 * requests carry a valid signature for the expected credential scope.
 */
export function verifySigV4(
  req: RecordedS3Request,
  creds: { accessKeyId: string; secretAccessKey: string; region: string; service?: string }
): { ok: boolean; scope: string; signedHeaders: string[] } {
  const service = creds.service ?? "s3"
  const auth = req.headers.authorization ?? ""
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
    auth
  )
  if (!match) return { ok: false, scope: "", signedHeaders: [] }
  const [, accessKeyId, date, region, svc, signedHeaderList, signature] = match
  const signedHeaders = signedHeaderList.split(";")
  const amzDate = req.headers["x-amz-date"] ?? ""
  const url = new URL(req.url)
  const canonicalHeaders = signedHeaders
    .map((name) => {
      const value = name === "host" ? url.host : (req.headers[name] ?? "")
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const canonicalRequest = [
    req.method,
    url.pathname,
    url.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaderList,
    req.headers["x-amz-content-sha256"] ?? "",
  ].join("\n")
  const scope = `${date}/${region}/${svc}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n")
  const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest()
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, svc)
  const kSigning = hmac(kService, "aws4_request")
  const expected = createHmac("sha256", kSigning).update(stringToSign).digest("hex")
  const ok =
    expected === signature &&
    accessKeyId === creds.accessKeyId &&
    region === creds.region &&
    svc === service &&
    amzDate.startsWith(date)
  return { ok, scope, signedHeaders }
}
