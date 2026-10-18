"""Audit F19: the versioned publication batch format ``corpus-publication-batch/1`` (pure tests).

The boundary (plan D16): a *structural* problem rejects the whole batch with BatchError before any
write (shape, types, unknown keys, duplicate item_key, more than 500 items, a bad batch_key, a
reference to a missing judgment item). *Semantic* problems (an unknown treatment kind, PK, missing
provenance, a null effective_from) parse, and publish_batch decides them per item.

BatchError messages name the field path, never the offending value (logs must not carry row data).
All data is synthetic (2099, "Test Act 2099").
"""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.publication import batch as b  # noqa: E402

PROVENANCE = {
    "source_name": "f19-curated-test",
    "source_url": "https://f19.example.invalid/judgment/1",
    "raw_storage_key": None,
    "fetched_at": "2099-01-02T03:04:05Z",
    "content_hash": "a" * 64,
    "extraction_method": "manual",
    "extractor_version": "f19-test-1",
}
TRUST = {"level": "trusted", "confidence": 0.9}


def judgment(item_key="j1", **over):
    item = {
        "kind": "judgment",
        "item_key": item_key,
        "trust": dict(TRUST),
        "provenance": dict(PROVENANCE),
        "citations": [{"parts": {"reporter": "PLD", "year": "2099", "page": "12", "court": "Karachi"}}, {"text": "2099 SCMR 1"}],
        "case_title": "F19 Fixture v. Test",
        "bench_type": "D.B.",
        "bench_size": 2,
        "decision_date": "2099-03-01",
        "full_text": "synthetic F19 fixture text",
    }
    item.update(over)
    return item


def treatment(item_key="t1", **over):
    item = {
        "kind": "treatment",
        "item_key": item_key,
        "trust": dict(TRUST),
        "provenance": dict(PROVENANCE),
        "treating": {"item_key": "j1"},
        "treated": {"citation": "2099 SCMR 2"},
        "treatment": "Overruled",
        "passage_anchor": "para 12",
        "treating_bench_type": "larger",
        "confidence": 0.9,
    }
    item.update(over)
    return item


def history(item_key="h1", **over):
    item = {
        "kind": "statute_section_history",
        "item_key": item_key,
        "trust": dict(TRUST),
        "provenance": dict(PROVENANCE),
        "statute": {"name": "Test Act 2099", "short_name": "TA", "year_enacted": 2099, "jurisdiction": "Federal", "status": None},
        "section": {"section_number": "5", "chapter": "II", "current_title": "Test section"},
        "history": "amendment_history",
        "versions": [
            {"version_no": 1, "effective_from": "2099-01-01", "effective_to": "2099-07-01", "title": "Test section", "text": "v1", "version_confidence": 0.9},
            {"version_no": 2, "effective_from": "2099-07-01", "effective_to": None, "text": "v2"},
        ],
    }
    item.update(over)
    return item


def batch(*items, **over):
    doc = {"format": b.BATCH_FORMAT, "batch_key": "curated/f19-test-1", "source_kind": "curated", "items": list(items)}
    doc.update(over)
    return doc


def raw(doc, **dump):
    return json.dumps(doc, **dump).encode("utf-8")


class ParseTests(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(b.BATCH_FORMAT, "corpus-publication-batch/1")
        self.assertEqual(b.MAX_BATCH_ITEMS, 500)
        self.assertEqual(b.MAX_BATCH_BYTES, 32 * 1024 * 1024)

    def test_minimal_batches_parse(self):
        minimal_judgment = {"kind": "judgment", "item_key": "j1", "trust": {"level": None, "confidence": None}, "provenance": {}, "citations": []}
        parsed = b.parse_batch_json(raw(batch(minimal_judgment)))
        self.assertEqual(parsed.items[0].kind, "judgment")
        self.assertIsNone(parsed.items[0].bench_type)
        self.assertEqual(len(b.parse_batch_json(raw(batch(judgment(), treatment()))).items), 2)
        parsed = b.parse_batch_json(raw(batch(history())))
        item = parsed.items[0]
        self.assertEqual(item.statute.name, "Test Act 2099")
        self.assertEqual(str(item.versions[0].effective_from), "2099-01-01")
        self.assertIsNone(item.versions[1].effective_to)

    def test_full_batch_round_trips_types(self):
        parsed = b.parse_batch_json(raw(batch(judgment(), treatment(), history())))
        j, t, h = parsed.items
        self.assertEqual(j.citations[0].parts.court, "Karachi")
        self.assertEqual(j.citations[1].text, "2099 SCMR 1")
        self.assertEqual(j.bench_size, 2)
        self.assertEqual(str(j.decision_date), "2099-03-01")
        self.assertEqual(j.provenance.fetched_at.year, 2099)
        self.assertEqual(t.treating.item_key, "j1")
        self.assertEqual(t.treated.citation, "2099 SCMR 2")
        self.assertEqual(h.history, "amendment_history")

    def test_semantic_problems_still_parse(self):
        doc = batch(
            judgment(provenance={}),
            treatment(treatment="reversed", treating_bench_type=None, confidence=0.1),
            history(statute={"name": "Test Act 2099", "jurisdiction": "PK", "status": "in force"},
                    versions=[{"version_no": 1, "effective_from": None, "effective_to": None, "text": "t"}]),
            judgment("j2", provenance={k: None for k in PROVENANCE}, bench_type="panel", citations=[{"text": "PLD 2099 Atlantis 1"}]),
        )
        parsed = b.parse_batch_json(raw(doc))
        self.assertEqual(parsed.items[1].treatment, "reversed")
        self.assertEqual(parsed.items[2].statute.jurisdiction, "PK")
        self.assertIsNone(parsed.items[2].versions[0].effective_from)
        self.assertIsNone(parsed.items[3].provenance.source_name)


class StructuralErrorTests(unittest.TestCase):
    SECRET = "f19-secret-value-2099"

    def assert_refused(self, doc_or_raw, *, value=None):
        data = doc_or_raw if isinstance(doc_or_raw, bytes) else raw(doc_or_raw)
        with self.assertRaises(b.BatchError) as ctx:
            b.parse_batch_json(data)
        message = str(ctx.exception)
        if value is not None:
            self.assertNotIn(value, message)
        self.assertNotIn(self.SECRET, message)
        return message

    def test_unknown_keys_at_each_level(self):
        S = self.SECRET
        self.assert_refused(batch(judgment(), extra=S))
        self.assert_refused(batch(judgment(extra=S)))
        self.assert_refused(batch(judgment(trust={**TRUST, "extra": S})))
        self.assert_refused(batch(judgment(provenance={**PROVENANCE, "extra": S})))
        self.assert_refused(batch(judgment(citations=[{"text": "2099 SCMR 1", "extra": S}])))
        self.assert_refused(batch(judgment(citations=[{"parts": {"reporter": "SCMR", "year": "2099", "page": "1", "extra": S}}])))
        self.assert_refused(batch(judgment(), treatment(treating={"item_key": "j1", "extra": S})))
        self.assert_refused(batch(history(statute={"name": "Test Act 2099", "jurisdiction": "Federal", "extra": S})))
        self.assert_refused(batch(history(section={"section_number": "5", "extra": S})))
        self.assert_refused(batch(history(versions=[{"version_no": 1, "effective_from": None, "effective_to": None, "text": "t", "extra": S}])))

    def test_wrong_format_kind_and_types(self):
        self.assert_refused(batch(judgment(), format="corpus-publication-batch/2"))
        self.assert_refused(batch(judgment(), source_kind="harvest"))
        self.assert_refused(batch(judgment(kind="opinion")))
        self.assert_refused(batch(judgment(bench_size="2")))
        self.assert_refused(batch(judgment(bench_size=0)))
        self.assert_refused(batch(judgment(trust={"level": "trusted"})))
        self.assert_refused(batch(judgment(trust={"level": "trusted", "confidence": True})))
        self.assert_refused(batch(judgment(), treatment(confidence=1.5)))
        self.assert_refused(batch(judgment(), treatment(confidence="0.9")))
        self.assert_refused(batch(judgment(decision_date="1 March 2099")), value="1 March 2099")
        self.assert_refused(batch(judgment(provenance={**PROVENANCE, "fetched_at": "2099-01-02T03:04:05"})))
        self.assert_refused(batch(history(history="partial")))
        self.assert_refused(batch(history(versions=[])))
        self.assert_refused(batch(history(versions=[{"version_no": 0, "effective_from": None, "effective_to": None, "text": "t"}])))
        self.assert_refused(batch(history(versions=[{"version_no": 1, "effective_from": None, "text": "t"}])))
        self.assert_refused(batch(judgment(citations=[{"parts": {"reporter": "SCMR", "year": "1899", "page": "1"}}])))
        self.assert_refused(batch(judgment(citations=[{"parts": {"reporter": "SCMR", "year": "2099", "page": "12A"}}])))
        self.assert_refused(batch(judgment(citations=[{"text": ""}])))
        self.assert_refused(batch(judgment(citations=[{"text": "2099 SCMR 1"}] * 11)))
        self.assert_refused(b"[]")
        self.assert_refused(b"{not json")
        self.assert_refused(b'{"format": NaN}')

    def test_nan_and_infinite_confidences_are_refused(self):
        # Re-audit D4: json.dumps writes NaN / Infinity literals; no confidence may carry one.
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assert_refused(batch(judgment(trust={"level": "trusted", "confidence": bad})))
            self.assert_refused(batch(judgment(), treatment(confidence=bad)))
            self.assert_refused(batch(history(trust={"level": "trusted", "confidence": bad})))
            self.assert_refused(batch(history(versions=[{"version_no": 1, "effective_from": "2099-01-01", "effective_to": None,
                                                         "text": "t", "version_confidence": bad}])))

    def test_nul_characters_are_refused(self):
        self.assert_refused(batch(judgment(full_text="text\u0000more")))

    def test_duplicate_item_key(self):
        self.assert_refused(batch(judgment("f19-twice-2099"), judgment("f19-twice-2099")), value="f19-twice-2099")

    def test_item_count_limits(self):
        self.assert_refused(batch())
        items = [judgment(f"j{i}") for i in range(501)]
        self.assert_refused(batch(*items))
        self.assertEqual(len(b.parse_batch_json(raw(batch(*items[:500]))).items), 500)

    def test_batch_and_item_keys(self):
        for bad in ("/x", "a b", "", "x" * 201, "a\n", "ä"):
            self.assert_refused(batch(judgment(), batch_key=bad))
        for bad in ("a/b", "", "x" * 101, "a b"):
            self.assert_refused(batch(judgment(bad)))
        b.parse_batch_json(raw(batch(judgment("a.b:c-d_e"), batch_key="staging/0f1e-2099.x:y")))

    def test_citation_with_both_text_and_parts(self):
        both = {"text": "2099 SCMR 1", "parts": {"reporter": "SCMR", "year": "2099", "page": "1"}}
        self.assert_refused(batch(judgment(citations=[both])))
        self.assert_refused(batch(judgment(citations=[{}])))

    def test_refs_must_name_a_judgment_item_in_the_batch(self):
        self.assert_refused(batch(judgment(), treatment(treating={"item_key": "nope"})), value="nope")
        self.assert_refused(batch(history("h1"), judgment(), treatment(treated={"item_key": "h1"})))
        self.assert_refused(batch(judgment(), treatment(treating={"item_key": "j1", "citation": "2099 SCMR 1"})))
        b.parse_batch_json(raw(batch(treatment(treating={"citation": "2099 SCMR 3"}))))

    def test_size_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "big.json"
            path.write_bytes(b" " * (b.MAX_BATCH_BYTES + 1))
            with self.assertRaises(b.BatchError):
                b.load_batch(path)
            ok = Path(tmp) / "ok.json"
            ok.write_bytes(raw(batch(judgment())))
            self.assertEqual(b.load_batch(ok).batch_key, "curated/f19-test-1")
        with self.assertRaises(b.BatchError):
            b.parse_batch_json(b" " * (b.MAX_BATCH_BYTES + 1))


class HashTests(unittest.TestCase):
    def test_batch_sha256_is_stable_under_reorder_and_whitespace(self):
        doc = batch(judgment(), treatment(), history())
        h1 = b.batch_sha256(b.parse_batch_json(raw(doc)))
        h2 = b.batch_sha256(b.parse_batch_json(raw(doc, indent=4, sort_keys=True)))
        reordered = json.loads(json.dumps(doc), object_pairs_hook=lambda pairs: dict(reversed(pairs)))
        h3 = b.batch_sha256(b.parse_batch_json(raw(reordered)))
        self.assertRegex(h1, r"^[0-9a-f]{64}$")
        self.assertEqual(h1, h2)
        self.assertEqual(h1, h3)
        # An omitted optional field and an explicit null are the same content.
        doc_null = copy.deepcopy(doc)
        doc_null["items"][0]["headnotes"] = None
        self.assertEqual(b.batch_sha256(b.parse_batch_json(raw(doc_null))), h1)

    def test_batch_sha256_changes_with_any_value(self):
        doc = batch(judgment(), treatment(), history())
        base = b.batch_sha256(b.parse_batch_json(raw(doc)))
        mutations = [
            lambda d: d["items"][0].__setitem__("full_text", "changed"),
            lambda d: d["items"][0]["trust"].__setitem__("confidence", 0.91),
            lambda d: d["items"][0]["provenance"].__setitem__("content_hash", "b" * 64),
            lambda d: d["items"][1].__setitem__("treatment", "followed"),
            lambda d: d["items"][2]["versions"][1].__setitem__("text", "v2 changed"),
            lambda d: d.__setitem__("source_kind", "staging"),
            lambda d: d.__setitem__("batch_key", "curated/f19-test-2"),
        ]
        seen = {base}
        for mutate in mutations:
            changed = copy.deepcopy(doc)
            mutate(changed)
            digest = b.batch_sha256(b.parse_batch_json(raw(changed)))
            self.assertNotIn(digest, seen)
            seen.add(digest)

    def test_canonical_json_and_entity_sha256(self):
        self.assertEqual(b.canonical_json({"b": 1, "a": [None, "ü"]}), '{"a":[null,"ü"],"b":1}'.encode("utf-8"))
        with self.assertRaises(ValueError):
            b.canonical_json({"x": float("nan")})
        e1 = b.entity_sha256("judgment", {"a": 1, "b": "x"})
        self.assertEqual(e1, b.entity_sha256("judgment", {"b": "x", "a": 1}))
        self.assertNotEqual(e1, b.entity_sha256("citation", {"a": 1, "b": "x"}))
        self.assertNotEqual(e1, b.entity_sha256("judgment", {"a": 2, "b": "x"}))
        self.assertRegex(e1, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
