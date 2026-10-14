import { createHash } from "node:crypto"
import { AwsClient } from "aws4fetch"

/**
 * A raw S3 client for tests only: it plays the operator (create buckets, copy a bucket for the
 * restore drill) and the attacker with bucket credentials (overwrite or truncate an object), so
 * the tests can check what the document vault really stored, independently of the code under test.
 */
export type S3TestTarget = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

export type S3TestResponse = { status: number; body: Buffer; text: string }

export function createS3TestClient(target: S3TestTarget) {
  const client = new AwsClient({
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: "s3",
    region: target.region,
    retries: 0,
  })
  const base = target.endpoint.replace(/\/+$/, "")

  /**
   * MinIO answers a refused conditional PUT before reading the body and may then reset the
   * connection, so the client sometimes sees ECONNRESET instead of the 412. Every call this
   * helper makes is safe to repeat, so a transport failure (no response at all) is retried a
   * bounded number of times; an HTTP status is always returned as received.
   */
  async function send(
    method: string,
    path: string,
    body?: Buffer,
    headers: Record<string, string> = {}
  ): Promise<S3TestResponse> {
    const payload = body ?? Buffer.alloc(0)
    let lastError: unknown
    for (let attempt = 1; attempt <= 5; attempt++) {
      const request = await client.sign(`${base}/${path}`, {
        method,
        body: body ? new Uint8Array(body) : undefined,
        headers: {
          "x-amz-content-sha256": createHash("sha256").update(payload).digest("hex"),
          ...headers,
        },
      })
      try {
        const res = await fetch(request)
        const buf = Buffer.from(await res.arrayBuffer())
        return { status: res.status, body: buf, text: buf.toString("utf8") }
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  async function expectOk(res: Promise<S3TestResponse>, what: string): Promise<S3TestResponse> {
    const r = await res
    if (r.status < 200 || r.status > 299) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`)
    return r
  }

  return {
    send,
    createBucket: (bucket: string) => expectOk(send("PUT", bucket), `create bucket ${bucket}`),
    putObject: (bucket: string, key: string, body: Buffer, headers?: Record<string, string>) =>
      send("PUT", `${bucket}/${key}`, body, headers),
    getObject: (bucket: string, key: string) => send("GET", `${bucket}/${key}`),
    deleteObject: (bucket: string, key: string) => send("DELETE", `${bucket}/${key}`),
    async listKeys(bucket: string): Promise<string[]> {
      const keys: string[] = []
      let token: string | undefined
      do {
        const query = `list-type=2${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`
        const res = await expectOk(send("GET", `${bucket}?${query}`), `list ${bucket}`)
        for (const m of res.text.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1])
        token = /<IsTruncated>true<\/IsTruncated>/.test(res.text)
          ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(res.text)?.[1]
          : undefined
      } while (token)
      return keys.sort()
    },
    async emptyAndDeleteBucket(bucket: string): Promise<void> {
      const keys = await this.listKeys(bucket).catch(() => [])
      for (const key of keys) await send("DELETE", `${bucket}/${key}`)
      await send("DELETE", bucket)
    },
  }
}

export type S3TestClient = ReturnType<typeof createS3TestClient>
