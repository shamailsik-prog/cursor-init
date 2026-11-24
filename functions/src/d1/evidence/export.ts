import { canonicalJson } from "../../http/idempotency"
import { getCustodyTrail } from "./custody"
import { requireD1Evidence } from "./flag"
import { getEvidenceItem } from "./register"
import type { CustodyEvent, EvidenceActor, EvidenceItem } from "./types"

/**
 * Custody report. JSON is `canonicalJson`, so the same stored trail is the
 * same bytes. Plain text is one field a line, events in seq order, every hash
 * included. There is no PDF renderer and no `exportedAt`, so a second call
 * cannot change the bytes.
 */

function show(value: string | null): string {
  return value === null ? "null" : value
}

export function renderEvidenceLog(item: EvidenceItem, events: readonly CustodyEvent[]): { json: string; text: string } {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
  const json = canonicalJson({
    evidence: {
      id: item.id,
      firmId: item.firmId,
      matterId: item.matterId,
      item: item.item,
      source: item.source,
      receiptDate: item.receiptDate,
      custodian: item.custodian,
      classification: item.classification,
      documentId: item.documentId,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      eventCount: item.eventCount,
    },
    events: ordered.map((event) => ({
      id: event.id,
      evidenceId: event.evidenceId,
      firmId: event.firmId,
      matterId: event.matterId,
      seq: event.seq,
      kind: event.kind,
      actorId: event.actorId,
      at: event.at,
      note: event.note,
      custodian: event.custodian,
      documentId: event.documentId,
      classification: event.classification,
      prevHash: event.prevHash,
      hash: event.hash,
    })),
  })
  const lines = [
    "EVIDENCE LOG",
    `id: ${item.id}`,
    `firmId: ${item.firmId}`,
    `matterId: ${item.matterId}`,
    `item: ${item.item}`,
    `source: ${item.source}`,
    `receiptDate: ${item.receiptDate}`,
    `custodian: ${item.custodian}`,
    `classification: ${item.classification}`,
    `documentId: ${show(item.documentId)}`,
    `createdBy: ${item.createdBy}`,
    `createdAt: ${item.createdAt}`,
    `eventCount: ${String(item.eventCount)}`,
    `events: ${String(ordered.length)}`,
  ]
  for (const event of ordered) {
    lines.push("---")
    lines.push(`seq: ${String(event.seq)}`)
    lines.push(`kind: ${event.kind}`)
    lines.push(`actorId: ${event.actorId}`)
    lines.push(`at: ${event.at}`)
    lines.push(`note: ${event.note}`)
    lines.push(`custodian: ${event.custodian}`)
    lines.push(`documentId: ${show(event.documentId)}`)
    lines.push(`classification: ${event.classification}`)
    lines.push(`prevHash: ${event.prevHash}`)
    lines.push(`hash: ${event.hash}`)
  }
  return { json, text: `${lines.join("\n")}\n` }
}

export async function exportEvidenceLog(caller: EvidenceActor, evidenceId: string): Promise<{ json: string; text: string }> {
  requireD1Evidence()
  const item = await getEvidenceItem(caller, evidenceId)
  const events = await getCustodyTrail(caller, evidenceId)
  return renderEvidenceLog(item, events)
}
