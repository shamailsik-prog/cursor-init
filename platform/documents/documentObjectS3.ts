import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3"
import { DocumentObjectConfigurationError } from "@/platform/documents/documentObjectStoreTypes"

let cachedClient: S3Client | undefined

export function resetDocumentObjectS3ClientForTests(): void {
  cachedClient = undefined
}

export function s3ConfigFromEnv(): {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  forcePathStyle: boolean
} {
  const endpoint = process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT?.trim()
  const bucket = process.env.SIKANDER_DOCUMENT_OBJECT_S3_BUCKET?.trim()
  const accessKeyId = process.env.SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY?.trim()
  const region = process.env.SIKANDER_DOCUMENT_OBJECT_S3_REGION?.trim() || "auto"
  const forcePathStyle =
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE?.trim() === "1" ||
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_FORCE_PATH_STYLE?.trim()?.toLowerCase() === "true"
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new DocumentObjectConfigurationError(
      "S3-compatible document storage requires SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT, " +
        "SIKANDER_DOCUMENT_OBJECT_S3_BUCKET, SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID, and " +
        "SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY"
    )
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey, region, forcePathStyle }
}

export function isDocumentObjectS3Configured(): boolean {
  return Boolean(
    process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT?.trim() &&
      process.env.SIKANDER_DOCUMENT_OBJECT_S3_BUCKET?.trim() &&
      process.env.SIKANDER_DOCUMENT_OBJECT_S3_ACCESS_KEY_ID?.trim() &&
      process.env.SIKANDER_DOCUMENT_OBJECT_S3_SECRET_ACCESS_KEY?.trim()
  )
}

function documentObjectS3EndpointHostname(): string | null {
  const raw = process.env.SIKANDER_DOCUMENT_OBJECT_S3_ENDPOINT?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}

function isCloudflareR2Hostname(hostname: string): boolean {
  return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com")
}

function isLocalOrDevMinioHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "minio"
}

/** Omit SSE on PutObject when the target rejects x-amz-server-side-encryption (R2) or has no KMS (local MinIO). */
export function documentObjectS3UsesServerSideEncryptionHeader(): boolean {
  const backend = process.env.SIKANDER_DOCUMENT_OBJECT_BACKEND?.trim().toLowerCase()
  if (backend === "r2") return false
  const hostname = documentObjectS3EndpointHostname()
  if (!hostname) return true
  if (isCloudflareR2Hostname(hostname) || isLocalOrDevMinioHostname(hostname)) return false
  return true
}

export function documentObjectS3Client(): S3Client {
  if (cachedClient) return cachedClient
  const cfg = s3ConfigFromEnv()
  cachedClient = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  })
  return cachedClient
}

export function objectKeyForS3StoragePath(storagePath: string): string {
  const prefix = "s3://"
  if (!storagePath.startsWith(prefix)) {
    throw new Error("document storagePath must use s3:// scheme")
  }
  const key = storagePath.slice(prefix.length)
  if (!key || key.includes("..")) {
    throw new Error("document object path failed safety validation")
  }
  return key
}

function putObjectInput(key: string, body: Buffer, ifNoneMatch?: string): PutObjectCommandInput {
  const { bucket } = s3ConfigFromEnv()
  const input: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/octet-stream",
  }
  if (ifNoneMatch) {
    input.IfNoneMatch = ifNoneMatch
  }
  if (documentObjectS3UsesServerSideEncryptionHeader()) {
    input.ServerSideEncryption = "AES256"
  }
  return input
}

export async function ensureDocumentObjectBucketExists(): Promise<void> {
  const { bucket } = s3ConfigFromEnv()
  try {
    await documentObjectS3Client().send(new CreateBucketCommand({ Bucket: bucket }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const name = err instanceof Error ? err.name : ""
    if (
      !/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(message) &&
      name !== "BucketAlreadyOwnedByYou" &&
      name !== "BucketAlreadyExists"
    ) {
      throw err
    }
  }
}

export async function writeS3Payload(storagePath: string, payload: Buffer): Promise<void> {
  const key = objectKeyForS3StoragePath(storagePath)
  const client = documentObjectS3Client()
  try {
    await client.send(new HeadObjectCommand({ Bucket: s3ConfigFromEnv().bucket, Key: key }))
    throw new Error("document object already exists (immutable)")
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    if (name === "NotFound" || name === "NoSuchKey") {
      // expected — object absent
    } else if (err instanceof Error && /already exists/i.test(err.message)) {
      throw err
    } else if (name !== "NotFound" && name !== "NoSuchKey") {
      const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (code !== 404) throw err
    }
  }
  try {
    await client.send(new PutObjectCommand(putObjectInput(key, payload, "*")))
  } catch (err) {
    const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const name = err instanceof Error ? err.name : ""
    if (code === 412 || name === "PreconditionFailed") {
      throw new Error("document object already exists (immutable)")
    }
    throw err
  }
}

export async function readS3Payload(storagePath: string): Promise<Buffer> {
  const { bucket } = s3ConfigFromEnv()
  const key = objectKeyForS3StoragePath(storagePath)
  try {
    const out = await documentObjectS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = out.Body
    if (!body) throw new Error(`document object not found: ${storagePath}`)
    const chunks: Buffer[] = []
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch (err) {
    const name = err instanceof Error ? err.name : ""
    if (name === "NoSuchKey" || name === "NotFound") {
      throw new Error(`document object not found: ${storagePath}`)
    }
    throw err
  }
}

export async function deleteS3Payload(storagePath: string, options?: { strict?: boolean }): Promise<void> {
  const { bucket } = s3ConfigFromEnv()
  const key = objectKeyForS3StoragePath(storagePath)
  try {
    await documentObjectS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    if (options?.strict) throw err
    // best-effort rollback outside strict mode
  }
}

export async function overwriteS3PayloadForTests(storagePath: string, payload: Buffer): Promise<void> {
  const key = objectKeyForS3StoragePath(storagePath)
  await documentObjectS3Client().send(new PutObjectCommand(putObjectInput(key, payload)))
}

export async function putS3ObjectIfNoneMatch(
  storagePath: string,
  payload: Buffer
): Promise<void> {
  const key = objectKeyForS3StoragePath(storagePath)
  await documentObjectS3Client().send(new PutObjectCommand(putObjectInput(key, payload, "*")))
}
