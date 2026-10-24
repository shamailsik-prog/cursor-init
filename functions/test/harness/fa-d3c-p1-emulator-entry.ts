import { readFileSync } from "node:fs"
import { setGlobalOptions } from "firebase-functions/v2"
import { adminDb } from "../../src/admin"
import { P1EmbeddingTransportError, setP1EmbeddingTransportForTests } from "../../src/p1/embeddingTransport"
import { setServiceKeysForTests, type JwkSet } from "../../src/p1/serviceAuth"
import { REGION } from "../../src/runtimeOptions"

/**
 * FA-D3C-002 end-to-end harness (spec R17), never deployed: the entry module the Functions emulator loads for
 * corpus_service/tests/e2e/p1_embedding_e2e.sh. It exports the real `p1CorpusEmbedding` (the real handler, OIDC check,
 * `callP1Embedding` and gateway.ts ledger code) with two test seams set, which the production bundle keeps inert
 * (`functions/build.mjs` defines NODE_ENV as "production"; this harness is bundled without that define):
 *
 * - the embedding transport is a deterministic fake that records each call (the masked input it was sent) in the
 *   Firestore collection `fa_d3c_test_transport_calls`, so the corpus-side test can count provider calls; an input
 *   carrying FAIL_MARKER fails as a billable timeout;
 * - the OIDC key set is the test key set in FA_D3C_TEST_JWKS_FILE (the corpus-side test signs with its private half).
 */

setGlobalOptions({ region: REGION })

export const FAIL_MARKER = "FA-D3C-PROVIDER-FAIL"
export const DIMENSIONS = 1536

/** The vector for a text: the first number is (sum of its UTF-16 code units mod 997 + 1) / 1000, the rest 0.001. */
export function vectorFor(text: string): number[] {
  let sum = 0
  for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i)
  return [((sum % 997) + 1) / 1000, ...new Array<number>(DIMENSIONS - 1).fill(0.001)]
}

// The emulator's discovery pass loads this module without the function's .env; the worker that serves requests has it.
// Without the file the handler falls back to Google's key set, which no test token passes: the e2e then fails, never
// passes vacuously.
const jwksFile = process.env.FA_D3C_TEST_JWKS_FILE
if (jwksFile) setServiceKeysForTests(JSON.parse(readFileSync(jwksFile, "utf8")) as JwkSet)

setP1EmbeddingTransportForTests({
  async embed({ model, input }) {
    await adminDb().collection("fa_d3c_test_transport_calls").add({ model, input, at: Date.now() })
    if (input.includes(FAIL_MARKER)) throw new P1EmbeddingTransportError("gateway_timeout", { billable: true })
    return { embedding: vectorFor(input), inputTokens: 7, model }
  },
})

export { p1CorpusEmbedding } from "../../src/p1/corpusEmbedding"
