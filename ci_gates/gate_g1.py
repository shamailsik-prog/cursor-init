#!/usr/bin/env python3
"""Gate G-1 — Spine. FAILS unless the ten Layer 18 §10.1 tests exist and pass.
Set SIKANDER_PHASE=0 to allow a documented skip during Phase 0 only (prints the required tests)."""
import os, pathlib, subprocess, sys
TESTS = [
 "1 triple upload same hash, three idempotency keys -> one document, reused:true, one OCR job",
 "2 WhatsApp /matters as clerk with two memberships -> two matters; client number -> own matters; client /research -> denied",
 "3 two 'Muhammad Ali' same CNIC -> candidate link; conflict -> POSSIBLE_CANDIDATE_REVIEW never CLEAR",
 "4 authority overruled by larger bench (treatment seeded) -> OVERRULED block; partner reason to override",
 "5 PPC section amended 2018, offence 2015 -> getSectionAsAt returns 2015 text; current text -> TEMPORAL-MISMATCH block",
 "6 matter without engagement confirmed -> no intimation row; after confirmation -> accounts notified; silence 24h -> L4.10",
 "7 privileged document -> translation request -> P1 blocks provider without DPA (ai.call.blocked) or requires partner reason",
 "8 classification downgrade without declassify() -> trigger exception; with partner declassify -> succeeds, audit logged",
 "9 'C.P. No. D-1234 of 2025' on SHC -> CP D-1234/2025 recorded; 'CP 1234' -> rejected, follow-up opened",
 "10 corpus_metadata.embedding_model changed while embeddings exist -> search refuses; reembedCorpus keeps old vectors until confirmed",
]
tf = pathlib.Path("tests/gate_g1.test.ts")
if not tf.exists():
    print("G-1 test file tests/gate_g1.test.ts is missing. Required tests:"); [print("  -", t) for t in TESTS]
    if os.environ.get("SIKANDER_PHASE") == "0": print("SKIP (Phase 0 declared) — G-1 cannot pass without these tests"); sys.exit(0)
    print("FAIL: G-1"); sys.exit(1)
txt = tf.read_text()
missing = [t for t in TESTS if f"G1-{t.split()[0]}" not in txt]
if missing:
    print("FAIL: test file lacks these test ids (label each test 'G1-<n>'):"); [print("  -", t) for t in missing]; sys.exit(1)
r = subprocess.run(["npm", "test", "--", "tests/gate_g1.test.ts"], capture_output=True, text=True)
print(r.stdout[-3000:]); print(r.stderr[-2000:])
sys.exit(r.returncode)
