/**
 * The template port (spec P4B-9): what the generation steps need to know about the stored drafting templates, and
 * nothing else. A call carries only a document type and a template id, never a matter id or party data (L19.11 #3).
 *
 * A type's `templateId` (data/documentTypes.json) names the template its deterministic-first generation would use.
 * No template is built yet, so production runs on EMPTY_TEMPLATE_STORE: it finds none, and a generation step that
 * would need one is refused 501 `deterministic_not_built` before any P1 call (Task 3's `deterministicFirstCheck`).
 * Tests inject an InMemoryTemplateStore through setTemplateStoreForTests.
 */

/** A stored template: the document type it belongs to and its id (the type's `templateId`). */
export type Template = { templateId: string; documentTypeId: string }

export interface TemplateStore {
  /** The template `templateId` of the document type `documentTypeId`, or null when the store holds none. */
  findTemplate(documentTypeId: string, templateId: string): Promise<Template | null>
}

/** The production adapter until the templates are built: it knows none, so a template-first generation is refused. */
export const EMPTY_TEMPLATE_STORE: TemplateStore = Object.freeze({
  async findTemplate() {
    return null
  },
})

/** For tests and local use. A template is found by its type and its id together, never by either alone. */
export class InMemoryTemplateStore implements TemplateStore {
  private readonly byType = new Map<string, Set<string>>()

  addTemplate(documentTypeId: string, templateId: string): this {
    const ids = this.byType.get(documentTypeId) ?? new Set<string>()
    ids.add(templateId)
    this.byType.set(documentTypeId, ids)
    return this
  }

  async findTemplate(documentTypeId: string, templateId: string): Promise<Template | null> {
    return this.byType.get(documentTypeId)?.has(templateId) === true ? { documentTypeId, templateId } : null
  }
}

let testStore: TemplateStore | null = null

/** Test-only override of the template store; null restores the empty one. */
export function setTemplateStoreForTests(s: TemplateStore | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setTemplateStoreForTests is test-only")
  testStore = s
}

/** The store the generation steps run against: a test's, else the empty one. */
export function activeTemplateStore(): TemplateStore {
  return testStore ?? EMPTY_TEMPLATE_STORE
}
