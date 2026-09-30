/** An error that maps directly onto an HTTP response: `status` + machine-readable `code`. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}
