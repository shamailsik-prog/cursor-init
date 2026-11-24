/** The live master entry is not the baseline this proposal recorded. */
export class LearningStaleError extends Error {
  readonly code = "learning_master_stale" as const

  constructor() {
    super("learning proposal is stale")
    this.name = "LearningStaleError"
  }
}
