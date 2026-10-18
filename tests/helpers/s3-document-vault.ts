/**
 * Test-side access to the S3-compatible document vault (MinIO in CI, standing in for Cloudflare R2).
 *
 * - `rawVault()` is a second, independent S3 client (its own connection, nothing shared with
 *   platform/documents/documentObjectS3.ts), used to look at what the product really stored and to
 *   tamper with it.
 * - `startS3FaultProxy()` sits between the product and MinIO and injects the failures the vault has
 *   to survive: hangs, lost or late PUTs, hostile error bodies, corrupted reads, failed deletes.
 *   It forwards the client's Host header unchanged, so MinIO still verifies the SigV4 signature.
 *
 * TLS: when the real endpoint is https (MinIO started with --certs-dir, as the production-mode e2e
 * needs, since production refuses a plain-http vault), the proxy serves https too, with the
 * certificate and key named by SIKANDER_TEST_S3_TLS_CERT / SIKANDER_TEST_S3_TLS_KEY. Node trusts
 * that certificate through NODE_EXTRA_CA_CERTS, set before the test process starts.
 */
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"

export const S3_ENDPOINT_ENV = "SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT"

export function realS3Endpoint(): string {
  const endpoint = process.env[S3_ENDPOINT_ENV]?.trim()
  if (!endpoint) {
    throw new Error(
      `${S3_ENDPOINT_ENV} is not set: run through npm run test:document-object-s3 (MinIO) instead of a plain vitest run`
    )
  }
  return endpoint
}

export type RawVault = {
  bucket: string
  ensureBucket(): Promise<void>
  get(key: string): Promise<Buffer | null>
  put(key: string, body: Buffer): Promise<void>
  remove(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
  close(): void
}

export function rawVault(endpoint = realS3Endpoint()): RawVault {
  const bucket = process.env.SIKANDER_DOCUMENT_OBJECT_S3_BUCKET?.trim() || "sikander-documents-ci"
  const client = new S3Client({
    region: process.env.SIKANDER_DOCUMENT_OBJECT_S3_REGION?.trim() || "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY ?? "",
    },
  })
  return {
    bucket,
    async ensureBucket() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      } catch (err) {
        const name = (err as Error).name
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err
      }
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return Buffer.from(await out.Body!.transformToByteArray())
      } catch (err) {
        if ((err as Error).name === "NoSuchKey") return null
        throw err
      }
    },
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
    async keys(prefix) {
      const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
      return (out.Contents ?? []).map((item) => item.Key!).filter(Boolean)
    },
    close() {
      client.destroy()
    },
  }
}

/** Key inside the bucket for an `s3://...` storagePath. */
export function keyOf(storagePath: string): string {
  if (!storagePath.startsWith("s3://")) throw new Error(`not an s3:// storagePath: ${storagePath}`)
  return storagePath.slice("s3://".length)
}

export type FaultMode =
  | { kind: "pass" }
  /** Accept the connection and never answer. */
  | { kind: "hang" }
  /** Answer a GET with its headers and half its body, then stall. */
  | { kind: "stall-get-body" }
  /** Read the PUT, drop the connection, never forward it: the object never appears. */
  | { kind: "put-lost" }
  /** Read the PUT, drop the connection, forward it to MinIO after `delayMs`: the object lands late. */
  | { kind: "put-lands-late"; delayMs: number }
  /** Answer every request of `method` with `status` and an XML error body chosen by the test. */
  | { kind: "error"; method: string; status: number; code: string; message: string }
  /**
   * Forward, but flip one byte in the body of the next GET that returns 200 (one shot); then pass,
   * or with `thenFailDelete` answer every DELETE with a 500.
   */
  | { kind: "corrupt-next-get"; thenFailDelete?: boolean }
  /** Answer a GET with 200 and a declared Content-Length of `bytes`, then close without a body. */
  | { kind: "declare-huge-get"; bytes: number }
  /** Answer a GET with 200, no Content-Length, and stream exactly `bytes` zero bytes. */
  | { kind: "stream-huge-get"; bytes: number }
  /** Answer a GET with 200, a Content-Length of `bytes`, half of them, then stall (no upstream needed). */
  | { kind: "stall-body"; bytes: number }
  /** Answer a GET with 200 and this exact body (no checksum headers). */
  | { kind: "serve-get"; body: Buffer }
  /**
   * A minimal in-memory S3 (no MinIO, no signature check): PUT honours If-None-Match: *, GET and
   * DELETE by path. With `dropNextPutResponse` the next PUT is stored and its connection dropped.
   */
  | { kind: "memory-s3"; dropNextPutResponse?: boolean; failDelete?: boolean }

export type SeenRequest = { method: string; path: string; headers: http.IncomingHttpHeaders }

export type FaultProxy = {
  endpoint: string
  setMode(mode: FaultMode): void
  /** Method, path and headers of every request the proxy saw. */
  seen: SeenRequest[]
  /** Objects held by the memory-s3 mode, by request path (/bucket/key). */
  memory: Map<string, Buffer>
  /** Resolves once every delayed forward (put-lands-late) has reached MinIO. */
  settled(): Promise<void>
  close(): Promise<void>
}

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function forward(
  target: URL,
  req: http.IncomingMessage,
  body: Buffer
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const headers = { ...req.headers }
  // Expect is never signed (SigV4 unsignable header); the body is already buffered here.
  delete headers.expect
  return new Promise((resolve, reject) => {
    const upstream = (target.protocol === "https:" ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on("error", reject)
      }
    )
    upstream.on("error", reject)
    upstream.end(body)
  })
}

export type TestTls = { cert: Buffer; key: Buffer }

/** The test certificate and key for an https MinIO, or null when the run uses plain http. */
export function testTlsFromEnv(): TestTls | null {
  const cert = process.env.SIKANDER_TEST_S3_TLS_CERT?.trim()
  const key = process.env.SIKANDER_TEST_S3_TLS_KEY?.trim()
  if (!cert || !key) return null
  return { cert: readFileSync(cert), key: readFileSync(key) }
}

export async function startS3FaultProxy(targetEndpoint = realS3Endpoint()): Promise<FaultProxy> {
  const target = new URL(targetEndpoint)
  const tls = target.protocol === "https:" ? testTlsFromEnv() : null
  if (target.protocol === "https:" && !tls) {
    throw new Error("an https S3 endpoint needs SIKANDER_TEST_S3_TLS_CERT and SIKANDER_TEST_S3_TLS_KEY for the fault proxy")
  }
  let mode: FaultMode = { kind: "pass" }
  const seen: SeenRequest[] = []
  const pending = new Set<Promise<unknown>>()
  const hanging = new Set<http.ServerResponse>()
  const memory = new Map<string, Buffer>()
  const s3Error = (res: http.ServerResponse, status: number, code: string) => {
    res.writeHead(status, { "Content-Type": "application/xml" })
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${code}</Message></Error>`)
  }

  const handler: http.RequestListener = async (req, res) => {
    const method = req.method ?? "GET"
    seen.push({ method, path: req.url ?? "", headers: req.headers })
    const current = mode
    try {
      if (current.kind === "hang") {
        hanging.add(res)
        req.resume()
        return
      }
      const body = await readAll(req)
      if (current.kind === "put-lost" && method === "PUT") {
        req.socket.destroy()
        return
      }
      if (current.kind === "put-lands-late" && method === "PUT") {
        req.socket.destroy()
        const late = new Promise((resolve) => setTimeout(resolve, current.delayMs)).then(() =>
          forward(target, req, body)
        )
        pending.add(late)
        late.catch(() => undefined).finally(() => pending.delete(late))
        return
      }
      if (current.kind === "memory-s3") {
        const key = (req.url ?? "").split("?")[0]
        if (method === "PUT") {
          if (req.headers["if-none-match"] === "*" && memory.has(key)) return s3Error(res, 412, "PreconditionFailed")
          memory.set(key, body)
          if (current.dropNextPutResponse) {
            mode = { kind: "memory-s3", failDelete: current.failDelete }
            req.socket.destroy()
            return
          }
          res.writeHead(200, { ETag: '"memory"', "Content-Length": "0" })
          res.end()
          return
        }
        if (method === "GET") {
          const found = memory.get(key)
          if (!found) return s3Error(res, 404, "NoSuchKey")
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(found.length) })
          res.end(found)
          return
        }
        if (method === "DELETE") {
          if (current.failDelete) return s3Error(res, 500, "InternalError")
          memory.delete(key)
          res.writeHead(204)
          res.end()
          return
        }
        return s3Error(res, 405, "MethodNotAllowed")
      }
      if (current.kind === "declare-huge-get" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(current.bytes) })
        res.flushHeaders()
        setTimeout(() => res.socket?.destroy(), 200)
        return
      }
      if (current.kind === "stream-huge-get" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" })
        const chunk = Buffer.alloc(1024 * 1024)
        let sent = 0
        const pump = () => {
          while (sent < current.bytes) {
            const piece = chunk.subarray(0, Math.min(chunk.length, current.bytes - sent))
            sent += piece.length
            if (!res.write(piece)) {
              res.once("drain", pump)
              return
            }
          }
          res.end()
        }
        res.on("close", () => {
          sent = current.bytes
        })
        pump()
        return
      }
      if (current.kind === "stall-body" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(current.bytes) })
        res.write(Buffer.alloc(Math.floor(current.bytes / 2)))
        hanging.add(res)
        return
      }
      if (current.kind === "serve-get" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(current.body.length) })
        res.end(current.body)
        return
      }
      if (current.kind === "error" && method === current.method) {
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${current.code}</Code>` +
          `<Message>${current.message}</Message><RequestId>${current.message}</RequestId></Error>`
        res.writeHead(current.status, { "Content-Type": "application/xml" })
        res.end(xml)
        return
      }
      const upstream = await forward(target, req, body)
      let out = upstream.body
      if (current.kind === "corrupt-next-get" && method === "GET" && upstream.status === 200 && out.length > 0) {
        out = Buffer.from(out)
        out[out.length - 1] ^= 0xff
        mode = current.thenFailDelete
          ? { kind: "error", method: "DELETE", status: 500, code: "InternalError", message: "delete refused by fault proxy" }
          : { kind: "pass" }
      }
      const headers = { ...upstream.headers }
      delete headers["transfer-encoding"]
      if (current.kind === "stall-get-body" && method === "GET" && upstream.status === 200) {
        headers["content-length"] = String(out.length)
        res.writeHead(upstream.status, headers)
        res.write(out.subarray(0, Math.floor(out.length / 2)))
        hanging.add(res)
        return
      }
      headers["content-length"] = String(out.length)
      res.writeHead(upstream.status, headers)
      res.end(out)
    } catch {
      req.socket.destroy()
    }
  }
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `${tls ? "https" : "http"}://127.0.0.1:${port}`,
    setMode(next) {
      mode = next
    },
    seen,
    memory,
    async settled() {
      await Promise.allSettled([...pending])
    },
    async close() {
      for (const res of hanging) res.socket?.destroy()
      hanging.clear()
      await Promise.allSettled([...pending])
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
