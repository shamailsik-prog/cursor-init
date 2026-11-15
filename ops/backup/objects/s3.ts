import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type ObjectVersion,
} from "@aws-sdk/client-s3"

export type ObjectVersionInfo = {
  versionId?: string
  isDeleteMarker?: boolean
  /** True only for the version S3 currently serves. An older intact version is not enough. */
  isLatest?: boolean
  key: string
}

export type ResolvedObjectTarget = { endpoint: string; bucket: string }

export interface VersionedObjectAccess {
  listVersions(key: string): Promise<ObjectVersionInfo[]>
  getVersion(key: string, versionId?: string): Promise<Buffer>
  put(key: string, body: Buffer): Promise<void>
  /** The endpoint and bucket this client actually writes. Declared locations are not a substitute. */
  resolvedTarget?(): Promise<ResolvedObjectTarget>
}

function endpointOrigin(resolved: unknown): string {
  if (typeof resolved === "string") return resolved.replace(/\/$/, "")
  if (resolved instanceof URL) return `${resolved.protocol}//${resolved.host}`
  if (resolved && typeof resolved === "object" && "url" in resolved && (resolved as { url: unknown }).url instanceof URL) {
    const url = (resolved as { url: URL }).url
    return `${url.protocol}//${url.host}`
  }
  if (resolved && typeof resolved === "object" && "hostname" in resolved) {
    const ep = resolved as { protocol?: string; hostname?: string; port?: number }
    const protocol = ep.protocol?.endsWith(":") ? ep.protocol : `${ep.protocol ?? "https"}:`
    const host = ep.hostname ?? ""
    const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
    const port = ep.port ? `:${ep.port}` : ""
    return `${protocol}//${bracketed}${port}`
  }
  throw new Error("object writer endpoint is not a URL")
}

export class S3Versioned implements VersionedObjectAccess {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async listVersions(key: string): Promise<ObjectVersionInfo[]> {
    const out = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key }))
    const versions = (out.Versions ?? []).filter((v) => v.Key === key)
    const markers = (out.DeleteMarkers ?? []).filter((v) => v.Key === key)
    return [
      ...versions.map((v) => ({ key, versionId: v.VersionId, isDeleteMarker: false, isLatest: v.IsLatest === true })),
      ...markers.map((v) => ({ key, versionId: v.VersionId, isDeleteMarker: true, isLatest: v.IsLatest === true })),
    ]
  }

  async getVersion(key: string, versionId?: string): Promise<Buffer> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId })
    )
    return Buffer.from(await out.Body!.transformToByteArray())
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }))
  }

  async resolvedTarget(): Promise<ResolvedObjectTarget> {
    const provider = this.client.config.endpoint as unknown
    const resolved = typeof provider === "function" ? await (provider as () => Promise<unknown>)() : provider
    return { endpoint: endpointOrigin(resolved), bucket: this.bucket }
  }
}
