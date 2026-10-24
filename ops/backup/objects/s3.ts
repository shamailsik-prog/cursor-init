import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type ObjectVersion,
} from "@aws-sdk/client-s3"

export type ObjectVersionInfo = { versionId?: string; isDeleteMarker?: boolean; key: string }

export interface VersionedObjectAccess {
  listVersions(key: string): Promise<ObjectVersionInfo[]>
  getVersion(key: string, versionId?: string): Promise<Buffer>
  put(key: string, body: Buffer): Promise<void>
}

export class S3Versioned implements VersionedObjectAccess {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async listVersions(key: string): Promise<ObjectVersionInfo[]> {
    const out = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key }))
    const versions = (out.Versions ?? []).filter((v) => v.Key === key)
    const markers = (out.DeleteMarkers ?? []).filter((v) => v.Key === key)
    return [
      ...versions.map((v) => ({ key, versionId: v.VersionId, isDeleteMarker: false })),
      ...markers.map((v) => ({ key, versionId: v.VersionId, isDeleteMarker: true })),
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
}
