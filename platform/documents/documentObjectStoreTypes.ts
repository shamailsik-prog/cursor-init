export class DocumentObjectConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentObjectConfigurationError"
  }
}
