export class DocumentObjectConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentObjectConfigurationError"
  }
}

export type DocumentObjectStoreOperation = "put" | "get" | "delete"

/**
 * A failed object-store call, reduced to facts this process owns: the operation, the HTTP status,
 * an S3 error code only when it is well formed, and how the call failed. It never carries the
 * underlying SDK error (no `cause`), so request headers, the SigV4 signature and the endpoint's
 * own error text cannot reach a log line through it.
 */
export class DocumentObjectStoreError extends Error {
  constructor(
    readonly operation: DocumentObjectStoreOperation,
    readonly failure: "http" | "timeout" | "network" | "integrity",
    readonly httpStatus: number | null,
    readonly s3Code: string | null,
    message: string
  ) {
    super(message)
    this.name = "DocumentObjectStoreError"
  }
}
