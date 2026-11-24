/**
 * Process-local mark that a learning seal must not be approved or committed.
 * change_proposals has no column a pending row may update: the status trigger
 * refuses pending → rejected, and every other column is frozen. This mark is
 * therefore not visible to a second process. GOV-291-001 stays open until a
 * persisted place exists.
 */
const voidedSealIds = new Set<string>()

export function markSealedVoid(proposalId: string): void {
  voidedSealIds.add(proposalId)
}

export function isSealedVoid(proposalId: string): boolean {
  return voidedSealIds.has(proposalId)
}
