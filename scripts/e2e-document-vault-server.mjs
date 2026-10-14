#!/usr/bin/env node
// FA-D16-001 server-level e2e: the real Next.js server (next dev) stores an uploaded document in
// an S3-compatible bucket through the R2 backend, and the download comes back byte-identical.
//
// The vitest e2e (tests/fa-d16-001.document-vault-s3.e2e.test.ts) calls the route handlers in
// process. This script adds what only a running server shows: the bundled route and Next.js's
// extended fetch. (It caught a Request body that Next.js re-streamed without Content-Length,
// which the bucket refused with 411.)
//
// Needs SIKANDER_TEST_S3_ENDPOINT, SIKANDER_TEST_S3_ACCESS_KEY_ID, SIKANDER_TEST_S3_SECRET_ACCESS_KEY
// (and optionally SIKANDER_TEST_S3_REGION). `npm run test:document-vault-server`.
import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { AwsClient } from "aws4fetch"

const endpoint = process.env.SIKANDER_TEST_S3_ENDPOINT?.trim()
const accessKeyId = process.env.SIKANDER_TEST_S3_ACCESS_KEY_ID?.trim()
const secretAccessKey = process.env.SIKANDER_TEST_S3_SECRET_ACCESS_KEY?.trim()
const region = process.env.SIKANDER_TEST_S3_REGION?.trim() || "us-east-1"
if (!endpoint || !accessKeyId || !secretAccessKey) {
  console.error("FAIL: SIKANDER_TEST_S3_ENDPOINT, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY are required")
  process.exit(2)
}

const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region, retries: 0 })
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const bucket = `fa-d16-server-${randomBytes(4).toString("hex")}`

async function s3call(method, path, body) {
  const bytes = body ? new Uint8Array(body) : undefined
  const signed = await s3.sign(`${endpoint.replace(/\/+$/, "")}/${path}`, {
    method,
    headers: { "x-amz-content-sha256": sha256(body ?? Buffer.alloc(0)) },
    body: bytes,
  })
  const res = await fetch(signed.url, { method, headers: signed.headers, body: bytes })
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) }
}

async function listKeys() {
  const res = await s3call("GET", `${bucket}?list-type=2`)
  return [...res.body.toString("utf8").matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const failures = []
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

const port = Number(process.env.E2E_DOCUMENT_VAULT_PORT) || (await freePort())
const base = `http://127.0.0.1:${port}`
const serverEnv = {
  ...process.env,
  NODE_ENV: "development",
  SIKANDER_AUTH_MODE: "insecure-dev",
  SIKANDER_PERSISTENCE_MODE: "memory",
  // Opens the test matter through the legacy Next route; no Functions emulator runs here.
  SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES: "true",
  SIKANDER_DOCUMENT_OBJECT_BACKEND: "r2",
  SIKANDER_R2_ENDPOINT: endpoint,
  SIKANDER_R2_BUCKET: bucket,
  SIKANDER_R2_ACCESS_KEY_ID: accessKeyId,
  SIKANDER_R2_SECRET_ACCESS_KEY: secretAccessKey,
  SIKANDER_R2_REGION: region,
  SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
}
delete serverEnv.FIREBASE_CONFIG
delete serverEnv.SIKANDER_DOCUMENT_OBJECT_ROOT

let server
let serverLog = ""
try {
  check("create bucket", (await s3call("PUT", bucket)).status === 200)
  server = spawn("npx", ["next", "dev", "--port", String(port)], {
    env: serverEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (d) => (serverLog += d))
  server.stderr.on("data", (d) => (serverLog += d))

  let ready = false
  for (let i = 0; i < 180 && !ready; i++) {
    try {
      ready = (await fetch(`${base}/`)).status < 500
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  if (!ready) throw new Error(`next dev did not become ready on ${base}`)

  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }

  const matter = await post("/api/d1/matters", {
    action: "create",
    actorId: "partner_a",
    firmId: "firmA",
    clientId: "client_a",
    title: "FA-D16 server e2e",
    courtId: "SHC",
    classification: "internal",
  })
  check("create matter", matter.status === 200, `HTTP ${matter.status}`)
  const matterId = matter.json.result.matter.id

  const original = Buffer.concat([
    Buffer.from("%PDF-1.7\nPLAINTEXT-MARKER-SERVER-E2E\n"),
    randomBytes(4096),
    Buffer.from("\n%%EOF\n"),
  ])
  const ingest = await post("/api/d1/documents", {
    action: "ingest",
    actorId: "partner_a",
    firmId: "firmA",
    matterId,
    contentBase64: original.toString("base64"),
    sourceChannel: "web",
    classification: "internal",
  })
  check("ingest through POST /api/d1/documents", ingest.status === 200, `HTTP ${ingest.status} ${ingest.status === 200 ? "" : JSON.stringify(ingest.json)}`)
  const doc = ingest.json.result.doc
  check("storagePath is r2://", /^r2:\/\/firmA\/documents\/doc_[0-9a-f-]{36}\/v1$/.test(doc.storagePath), doc.storagePath)

  const key = `${doc.storagePath.slice("r2://".length)}.enc`
  const keys = await listKeys()
  check("bucket holds exactly the uploaded object", keys.length === 1 && keys[0] === key, JSON.stringify(keys))
  const remote = await s3call("GET", `${bucket}/${key}`)
  check(
    "bucket object is the encrypted envelope, never plaintext",
    remote.status === 200 &&
      remote.body[0] === 1 &&
      remote.body.length === original.length + 29 &&
      !remote.body.includes(Buffer.from("PLAINTEXT-MARKER"))
  )

  const download = async () => {
    const res = await fetch(`${base}/api/d1/documents?userId=partner_a&docId=${doc.id}&includeContent=true`)
    return { status: res.status, json: await res.json() }
  }
  const got = await download()
  const bytes = got.json.contentBase64 ? Buffer.from(got.json.contentBase64, "base64") : Buffer.alloc(0)
  check("download is byte-identical", got.status === 200 && bytes.equals(original), `HTTP ${got.status}`)
  check(
    "download hash matches the stored contentHash",
    got.json.contentHash === doc.contentHash && sha256(Buffer.concat([Buffer.from("firmA"), bytes])) === doc.contentHash
  )

  const tampered = Buffer.from(remote.body)
  tampered[64] ^= 0x01
  check("tamper the object in the bucket", (await s3call("PUT", `${bucket}/${key}`, tampered)).status === 200)
  const afterTamper = await download()
  check("tampered object is refused on download", afterTamper.status === 500, `HTTP ${afterTamper.status}`)
} catch (err) {
  check("server e2e ran to completion", false, err instanceof Error ? err.message : String(err))
  console.error(serverLog.split("\n").slice(-40).join("\n"))
} finally {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  for (const k of await listKeys().catch(() => [])) await s3call("DELETE", `${bucket}/${k}`).catch(() => {})
  await s3call("DELETE", bucket).catch(() => {})
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("PASS: document vault server e2e")
