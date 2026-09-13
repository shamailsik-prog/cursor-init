import type { SpineStore } from "@/platform/spine/store"

export function searchCorpus(
  store: SpineStore,
  queryModel: string
): { items: { entityId: string }[] } {
  const live = store.corpusMetadata.embedding_model
  const dim = Number(store.corpusMetadata.embedding_dim)
  if (dim !== 1536) throw new Error("search refuses: embedding_dim mismatch")
  if (queryModel !== live) {
    throw new Error("search refuses: embedding_model mismatch")
  }
  if (
    store.embeddings.length > 0 &&
    store.embeddings.some((e) => e.model !== live)
  ) {
    throw new Error("search refuses: embedding_model mismatch")
  }
  return {
    items: store.embeddings
      .filter((e) => e.model === queryModel)
      .map((e) => ({ entityId: e.entityId })),
  }
}

export function changeEmbeddingModel(store: SpineStore, nextModel: string) {
  store.corpusMetadata.embedding_model = nextModel
}

export function reembedCorpus(store: SpineStore, nextModel: string, confirmed: boolean) {
  if (!confirmed) {
    return { keptOld: true, model: store.embeddings[0]?.model ?? null }
  }
  store.reembedConfirmed = true
  for (const row of store.embeddings) {
    row.model = nextModel
  }
  store.corpusMetadata.embedding_model = nextModel
  return { keptOld: false, model: nextModel }
}
