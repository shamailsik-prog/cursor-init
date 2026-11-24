import { canonicalJson } from "../../http/idempotency"
import { getCustodyTrail } from "./custody"
import { requireD1Evidence } from "./flag"
import { EvidenceError, type ChainVerification, type CustodyEvent, type EvidenceActor, type EvidenceItem, type GenesisEvent } from "./types"

/**
 * Custody report. JSON is `canonicalJson`, so the same stored trail is the
 * same bytes. Plain text is one field a line, events in seq order, every hash
 * included. The header and the trail come from one read. A chain that is not
 * intact is refused. There is no PDF renderer and no `exportedAt`.
 */

function show(value: string | null): string {
  return value === null ? "null" : value
}

export function renderEvidenceLog(
  item: EvidenceItem,
  events: readonly CustodyEvent[],
  genesis: GenesisEvent | null
): { json: string; text: string } {
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
      headerHash: item.headerHash,
      lastHash: item.lastHash,
    },
    genesis: genesis
      ? {
          id: genesis.id,
          seq: genesis.seq,
          item: genesis.item,
          source: genesis.source,
          receiptDate: genesis.receiptDate,
          classification: genesis.classification,
          firmId: genesis.firmId,
          matterId: genesis.matterId,
          prevHash: genesis.prevHash,
          hash: genesis.hash,
        }
      : null,
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
    `headerHash: ${item.headerHash}`,
    `lastHash: ${item.lastHash}`,
    `events: ${String(ordered.length)}`,
  ]
  if (genesis) {
    lines.push("---")
    lines.push("seq: 0")
    lines.push("kind: genesis")
    lines.push(`item: ${genesis.item}`)
    lines.push(`source: ${genesis.source}`)
    lines.push(`receiptDate: ${genesis.receiptDate}`)
    lines.push(`classification: ${genesis.classification}`)
    lines.push(`firmId: ${genesis.firmId}`)
    lines.push(`matterId: ${genesis.matterId}`)
    lines.push(`prevHash: ${genesis.prevHash}`)
    lines.push(`hash: ${genesis.hash}`)
  }
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

export async function exportEvidenceLog(
  caller: EvidenceActor,
  evidenceId: string
): Promise<{ json: string; text: string; verdict: ChainVerification }> {
  requireD1Evidence()
  const snap = await getCustodyTrail(caller, evidenceId)
  if (!snap.verdict.ok || !snap.genesis) throw new EvidenceError("chain_broken", snap.verdict)
  return { ...renderEvidenceLog(snap.item, snap.events, snap.genesis), verdict: snap.verdict }
}
