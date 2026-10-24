export type FirestoreDoc = { path: string; data: Record<string, unknown> }
export type FirestoreIndex = Map<string, FirestoreDoc>

export type RelationshipViolation = { check: string; path: string; detail?: string }
export type RelationshipReport = { count: number; samples: RelationshipViolation[] }

const MAX_SAMPLES = 20

function sample(report: RelationshipReport, v: RelationshipViolation): void {
  report.count += 1
  if (report.samples.length < MAX_SAMPLES) report.samples.push(v)
}

function firmOf(data: Record<string, unknown>): string | null {
  const f = data.firmId
  if (typeof f !== "string" || !f.trim()) return null
  return f
}

function docExists(index: FirestoreIndex, path: string): boolean {
  return index.has(path)
}

export function runRelationshipChecks(index: FirestoreIndex): Record<string, RelationshipReport> {
  const reports: Record<string, RelationshipReport> = {}
  const mk = (name: string) => {
    if (!reports[name]) reports[name] = { count: 0, samples: [] }
    return reports[name]
  }

  for (const doc of index.values()) {
    const firm = firmOf(doc.data)
    if (doc.path.startsWith("firms/") || doc.path.startsWith("clients/") || doc.path.startsWith("matters/")) {
      const r = mk("firm_exists")
      if (!firm) sample(r, { check: "firm_exists", path: doc.path, detail: "firm_missing" })
      else if (!docExists(index, `firms/${firm}`)) sample(r, { check: "firm_exists", path: doc.path, detail: firm })
    }
    if (doc.path.startsWith("matters/") && doc.data.clientId) {
      const r = mk("matter_client")
      const cid = String(doc.data.clientId)
      const target = `clients/${cid}`
      if (!docExists(index, target) || firmOf(index.get(target)?.data ?? {}) !== firm) {
        sample(r, { check: "matter_client", path: doc.path })
      }
    }
    if (doc.path.startsWith("matter_parties/") && doc.data.matterId) {
      const r = mk("party_matter")
      const mid = String(doc.data.matterId)
      const matter = index.get(`matters/${mid}`)
      if (!matter || firmOf(matter.data) !== firm) sample(r, { check: "party_matter", path: doc.path })
    }
    if (doc.path.startsWith("matter_members/") && doc.data.matterId && doc.data.userId) {
      const r = mk("member_matter")
      const matter = index.get(`matters/${String(doc.data.matterId)}`)
      const user = index.get(`users/${String(doc.data.userId)}`)
      if (!matter || !user || firmOf(matter.data) !== firm || firmOf(user.data) !== firm) {
        sample(r, { check: "member_matter", path: doc.path })
      }
    }
    if (doc.path.startsWith("documents/") && doc.data.matterId) {
      const r = mk("document_matter")
      const matter = index.get(`matters/${String(doc.data.matterId)}`)
      if (!matter || firmOf(matter.data) !== firm) sample(r, { check: "document_matter", path: doc.path })
    }
    if (doc.path.startsWith("audit_log/") && typeof doc.data.target === "string") {
      const target = doc.data.target
      const r = mk("audit_target")
      if (!target.includes("/")) sample(r, { check: "audit_target_opaque", path: doc.path })
      else if (!docExists(index, target)) sample(r, { check: "audit_target", path: doc.path, detail: target })
    }
  }
  return reports
}
