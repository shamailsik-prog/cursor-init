import { classifyAnnexureRule, letterToken, type ClassifiedRule } from "@/layers/L5_5_DocketGenerator/rules"
import { assignedCitation, scanCitations, type CitationFamily } from "@/layers/L5_5_DocketGenerator/references"
import type { AmbiguityItem, DocketAnnexure, DocketFilingSet, DocketPageSizeName } from "@/layers/L5_5_DocketGenerator/types"

export type ResolvedAnnexure = {
  artifactId: string
  token: string
  indexLabel: string
  heading: string
  description: string
  body: string
}

export type ResolvedDocket = {
  pageSize: DocketPageSizeName
  pagination: "odd" | "sequential"
  draftBody: string
  annexures: ResolvedAnnexure[]
}

export type ResolveResult =
  | { ok: true; docket: ResolvedDocket }
  | { ok: false; queue: AmbiguityItem[] }

function item(code: AmbiguityItem["code"], artifactId: string | null, detail: string): AmbiguityItem {
  return { code, artifactId, detail }
}

function cleanDescription(label: string): string | null {
  const text = label.trim()
  if (!text || text.includes("|") || /[\r\n]/.test(label)) return null
  return text
}

function boundedIndex(text: string, label: string): number {
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(label, from)
    if (at < 0) return -1
    const before = at === 0 || /[^A-Za-z0-9]/.test(text[at - 1] ?? "")
    const afterAt = at + label.length
    const after = afterAt >= text.length || /[^A-Za-z0-9]/.test(text[afterAt] ?? "")
    if (before && after) return at
    from = at + 1
  }
  return -1
}

function assignedKey(token: string): string {
  return assignedCitation(token)?.form ?? `raw:${token.trim()}`
}

function seriesKind(token: string): string | null {
  return assignedCitation(token)?.series ?? null
}

function citationContext(
  scheme: ClassifiedRule["scheme"],
  annexures: readonly ResolvedAnnexure[],
): { family: CitationFamily; markPrefix: string | null } {
  if (scheme.kind === "letters" || scheme.kind === "single-a") return { family: "letter", markPrefix: null }
  if (scheme.kind === "enclosures") return { family: "number", markPrefix: null }
  const described = annexures.map((annexure) => assignedCitation(annexure.token))
  if (described.every((entry) => entry?.form.startsWith("mark:"))) {
    const prefixes = new Set(described.map((entry) => entry?.series?.slice("mark-".length) ?? ""))
    return { family: "mark", markPrefix: prefixes.size === 1 ? ([...prefixes][0] ?? null) : null }
  }
  if (described.every((entry) => entry?.form.startsWith("encl:"))) return { family: "number", markPrefix: null }
  return { family: "letter", markPrefix: null }
}

function pageSpec(
  classified: ClassifiedRule,
  forumPageSize: DocketPageSizeName | undefined,
  queue: AmbiguityItem[],
): { pageSize: DocketPageSizeName; pagination: "odd" | "sequential" } | null {
  if (forumPageSize && classified.pageSize !== "forum" && forumPageSize !== classified.pageSize) {
    queue.push(
      item(
        "ref_unresolved",
        null,
        `forum page size ${forumPageSize} contradicts the annexure rule page size ${classified.pageSize}`,
      ),
    )
    return null
  }
  if (classified.pageSize === "forum") {
    if (!forumPageSize) {
      queue.push(item("ref_unresolved", null, "annexure rule defers page size to the forum and forumPageSize is absent"))
      return null
    }
    return { pageSize: forumPageSize, pagination: forumPageSize === "legal" ? "odd" : "sequential" }
  }
  return {
    pageSize: classified.pageSize,
    pagination: classified.pagination === "sequential" ? "sequential" : "odd",
  }
}

function tokenFor(
  annexure: DocketAnnexure,
  index: number,
  classified: ClassifiedRule,
  queue: AmbiguityItem[],
): string | null {
  const id = annexure.metadata.artifactId || null
  const scheme = classified.scheme
  if (scheme.kind === "letters") {
    const expected = letterToken(index)
    if (!expected) {
      queue.push(item("label_unresolved", id, "letter series stops at Z; a further annexure has no stated token"))
      return null
    }
    if (annexure.assignedLabel !== undefined && annexure.assignedLabel !== expected) {
      queue.push(item("label_unresolved", id, `assigned label ${annexure.assignedLabel} is not ${expected}`))
      return null
    }
    return expected
  }
  if (scheme.kind === "enclosures") {
    const expected = String(index + 1)
    if (annexure.assignedLabel !== undefined && annexure.assignedLabel !== expected) {
      queue.push(item("label_unresolved", id, `assigned label ${annexure.assignedLabel} is not ${expected}`))
      return null
    }
    return expected
  }
  if (scheme.kind === "single-a") {
    if (index === 0) {
      if (annexure.assignedLabel !== undefined && annexure.assignedLabel !== "A") {
        queue.push(item("label_unresolved", id, `assigned label ${annexure.assignedLabel} is not A`))
        return null
      }
      return "A"
    }
    if (!annexure.assignedLabel) {
      queue.push(
        item(
          "label_unresolved",
          id,
          "annexure rule names Annexure A and then the record relied on without a further series",
        ),
      )
      return null
    }
    return annexure.assignedLabel
  }
  if (scheme.kind === "ambiguous" && !annexure.assignedLabel) {
    queue.push(item("label_unresolved", id, scheme.detail))
    return null
  }
  if (!annexure.assignedLabel) {
    queue.push(item("label_unresolved", id, "annexure rule does not state a series for this annexure"))
    return null
  }
  return annexure.assignedLabel
}

function presentation(token: string, scheme: ClassifiedRule["scheme"], index: number): { indexLabel: string; heading: string } {
  if (scheme.kind === "letters" || (scheme.kind === "single-a" && index === 0)) {
    return { indexLabel: `Annexure ${token}`, heading: `ANNEXURE ${token}` }
  }
  if (scheme.kind === "enclosures") {
    return { indexLabel: `Enclosure ${token}`, heading: `ENCLOSURE ${token}` }
  }
  return { indexLabel: token, heading: token }
}

function checkCitations(
  draft: string,
  annexures: readonly ResolvedAnnexure[],
  requireReferenceOrder: boolean,
  queue: AmbiguityItem[],
  scheme: ClassifiedRule["scheme"],
): void {
  const keys = annexures.map((annexure) => assignedKey(annexure.token))
  const knownKeys = new Set(keys)
  const context = citationContext(scheme, annexures)
  const scan = scanCitations(draft, { ...context, assigned: knownKeys })
  const known: string[] = []
  for (const hit of scan.hits) {
    if (!knownKeys.has(hit.form)) {
      queue.push(item("ref_unresolved", null, `body cites ${hit.canonical}, which is not an annexure in this filing set`))
      continue
    }
    if (!known.includes(hit.form)) known.push(hit.form)
  }
  for (const detail of scan.unparsed) {
    queue.push(item("ref_unresolved", null, detail))
  }
  if (!requireReferenceOrder) return
  annexures.forEach((annexure, index) => {
    const key = keys[index] ?? ""
    if (!known.includes(key)) {
      queue.push(item("ref_unresolved", annexure.artifactId, `body does not refer to ${annexure.token}`))
    }
  })
  if (known.length === keys.length && known.join("\0") !== keys.join("\0")) {
    queue.push(item("order_unresolved", null, "body refers to the annexures in a different order from the filing set"))
  }
}

function checkManualRefs(
  draft: string,
  annexures: readonly ResolvedAnnexure[],
  requireReferenceOrder: boolean,
  queue: AmbiguityItem[],
): void {
  if (!requireReferenceOrder) return
  const places = annexures.map((annexure) => ({
    annexure,
    at: boundedIndex(draft, annexure.indexLabel),
  }))
  for (const place of places) {
    if (place.at < 0) {
      queue.push(item("ref_unresolved", place.annexure.artifactId, `body does not refer to ${place.annexure.indexLabel}`))
    }
  }
  const found = places.filter((place) => place.at >= 0)
  const sorted = [...found].sort((a, b) => a.at - b.at)
  if (found.length === annexures.length && sorted.some((place, index) => place.annexure !== found[index]?.annexure)) {
    queue.push(item("order_unresolved", null, "body refers to the annexures in a different order from the filing set"))
  }
}

export function resolveFilingSet(input: DocketFilingSet): ResolveResult {
  const queue: AmbiguityItem[] = []
  const classified = classifyAnnexureRule(input.annexureRule)
  if (!classified) {
    queue.push(item("label_unresolved", null, "annexure rule is not one of the stated document-type schemes"))
    return { ok: false, queue }
  }

  const spec = pageSpec(classified, input.forumPageSize, queue)
  if (!input.draft.body.trim()) {
    queue.push(item("ref_unresolved", null, "draft body is empty"))
  }

  const seenIds = new Set<string>()
  const ordersSpecified = input.annexures.some((annexure) => annexure.order !== undefined)
  input.annexures.forEach((annexure, index) => {
    const id = annexure.metadata.artifactId.trim()
    if (!id) {
      queue.push(item("label_unresolved", null, "annexure artifactId is empty"))
    } else if (seenIds.has(id)) {
      queue.push(item("label_unresolved", id, "artifactId is duplicated"))
    } else {
      seenIds.add(id)
    }
    if (ordersSpecified && annexure.order !== index + 1) {
      queue.push(
        item(
          "order_unresolved",
          id || null,
          `order ${String(annexure.order)} does not match position ${index + 1}; the filing set is not reordered`,
        ),
      )
    }
    if (!cleanDescription(annexure.metadata.label)) {
      queue.push(item("label_unresolved", id || null, "annexure description is empty or contains a reserved character"))
    }
    if (!annexure.metadata.sourceRef?.trim()) {
      queue.push(item("ref_unresolved", id || null, "sourceRef is absent"))
    }
    if (!annexure.body.trim()) {
      queue.push(item("ref_unresolved", id || null, "annexure body is empty"))
    }
    if (annexure.metadata.status === "pending" || annexure.metadata.status === "blocked") {
      queue.push(item("ref_unresolved", id || null, `annexure status is ${annexure.metadata.status}`))
    }
  })

  const tokens = input.annexures.map((annexure, index) => tokenFor(annexure, index, classified, queue))
  if (queue.length > 0 || !spec || tokens.some((token) => token === null)) {
    return { ok: false, queue }
  }

  const resolvedTokens = tokens as string[]
  if (new Set(resolvedTokens).size !== resolvedTokens.length) {
    queue.push(item("label_unresolved", null, "annexure labels are not unique"))
  }
  for (let i = 0; i < resolvedTokens.length; i++) {
    for (let j = i + 1; j < resolvedTokens.length; j++) {
      const left = resolvedTokens[i] ?? ""
      const right = resolvedTokens[j] ?? ""
      if (boundedIndex(left, right) >= 0 || boundedIndex(right, left) >= 0) {
        queue.push(item("label_unresolved", null, `labels ${left} and ${right} cannot be told apart in a reference`))
      }
    }
  }

  const annexures: ResolvedAnnexure[] = input.annexures.map((annexure, index) => {
    const token = resolvedTokens[index] ?? ""
    const shown = presentation(token, classified.scheme, index)
    return {
      artifactId: annexure.metadata.artifactId.trim(),
      token,
      indexLabel: shown.indexLabel,
      heading: shown.heading,
      description: annexure.metadata.label.trim(),
      body: annexure.body.replace(/\r\n/g, "\n"),
    }
  })

  const draft = input.draft.body.replace(/\r\n/g, "\n")
  const scheme = classified.scheme
  if (scheme.kind === "ambiguous") {
    const kinds = [
      ...new Set(annexures.map((annexure) => seriesKind(annexure.token)).filter((kind): kind is string => kind !== null)),
    ]
    if (kinds.length > 1) {
      queue.push(item("label_unresolved", null, `assigned labels mix series (${kinds.join(", ")})`))
    }
  }
  const requireReferenceOrder =
    (scheme.kind === "letters" || scheme.kind === "enclosures" || scheme.kind === "manual") && scheme.requireReferenceOrder
  checkCitations(draft, annexures, requireReferenceOrder, queue, scheme)
  if (scheme.kind === "manual") checkManualRefs(draft, annexures, scheme.requireReferenceOrder, queue)

  if (queue.length > 0 || !spec) return { ok: false, queue }
  return {
    ok: true,
    docket: {
      pageSize: spec.pageSize,
      pagination: spec.pagination,
      draftBody: draft,
      annexures,
    },
  }
}
