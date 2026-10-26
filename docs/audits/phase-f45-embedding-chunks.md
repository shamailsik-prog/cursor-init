# Phase audit — F45 embedding chunk coverage

Finding **F45** (issue #30): embedding input used only the first 2,000 characters of
`full_text` / `section_text`, so late holdings never entered the vector index.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `54b4dfbc` (main after F44 #148): `embeddings.py` read `substr(body, 1, 2000)` and sent one mixed title/body string per queue row | Controlling text after 2,000 characters was never embedded; a `completed` queue row implied full-document coverage |
| GREEN (this PR) | `embedding_chunks.py` splits the full body into versioned chunks (`f45-chunk-v1`) with `char_start`/`char_end`, paragraph anchors, and `content_hash`; `record_embedding_chunks` stores one vector per chunk; the queue completes on a manifest operation id over all chunk hashes | `corpus_service/tests/test_f45_embedding_chunks.py` (unit + DB integration with provider stub) |

## Scope note

F45 closes the truncation hole and records chunk identity for later retrieval work. Hybrid
lexical/vector ranking evaluation, Urdu-specific eval, and Annex A `corpus_embeddings` backfill
remain out of scope; public search is still substring SQL — do not claim live RAG.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
