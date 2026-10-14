/** Persistence is misconfigured; requests fail closed instead of silently using memory. */
export class PersistenceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PersistenceConfigurationError"
  }
}
