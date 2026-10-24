#!/usr/bin/env python3
"""Tests for ci_gates/check_data_inventory.py (audit F42). Run: python3 ci_gates/test_check_data_inventory.py -v"""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import check_data_inventory as gate

ROOT = Path(__file__).resolve().parents[1]


class ShippedTree(unittest.TestCase):
    def test_shipped_tree_passes(self) -> None:
        findings, _notes = gate.run(ROOT)
        self.assertEqual(findings, [], msg="\n".join(f"{f.check}: {f.message}" for f in findings))

    def test_every_store_names_a_profile_with_the_four_answers(self) -> None:
        inventory = gate.load_json(ROOT, gate.INVENTORY)
        for store in inventory["stores"]:
            profile = inventory["profiles"][store["profile"]]
            for field in gate.PROFILE_FIELDS:
                self.assertTrue(profile[field].strip(), msg=f"{store['id']} {field}")
            self.assertIn("kind", store["key"], msg=store["id"])

    def test_the_brief_stores_are_inventoried(self) -> None:
        ids = {s["id"] for s in gate.load_json(ROOT, gate.INVENTORY)["stores"]}
        for sid in (
            "firestore:matters", "firestore:matter_members", "firestore:documents", "firestore:clients",
            "firestore:matter_client_search_index", "firestore:matter_report_export_analytics",
            "objects:documents", "firestore:drafts", "firestore:draft_versions", "firestore:draft_gate_results",
            "firestore:ai_usage_logs", "firestore:committee_outputs", "firestore:p1_ocr_operations",
            "external:opik", "firestore:p1_decisions", "postgres:judgment", "postgres:corpus_embeddings",
            "firestore:audit_log", "firestore:audit_outbox", "backup:firestore", "backup:postgres",
            "firestore:matter_tombstones", "firestore:deletion_requests", "firestore:deletion_acks", "firestore:legal_holds",
        ):
            self.assertIn(sid, ids)

    def test_the_default_policy_retains_everything_and_holds_matter_content(self) -> None:
        policy = gate.load_json(ROOT, gate.POLICY)
        self.assertIn("PROPOSED", policy["status"])
        self.assertIsNone(policy["ratifiedBy"])
        for name, cls in policy["classes"].items():
            self.assertEqual(cls["onMatterDeletion"], "retain", msg=name)
            self.assertEqual(cls["periodicAction"], "retain", msg=name)
            self.assertIsNone(cls["periodDays"], msg=name)
        for name in ("matter_record", "matter_content", "derived_index", "ai_record", "job_record", "legacy_matter_ops", "vault_object"):
            self.assertTrue(policy["classes"][name]["legalHold"], msg=name)


class Planted(unittest.TestCase):
    """A small synthetic tree: two rules collections, one code collection, one object prefix, one table."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "infra/backup").mkdir(parents=True)
        for name in ("firestore-backup.json", "postgres-backup.json"):
            shutil.copy(ROOT / "infra/backup" / name, self.root / "infra/backup" / name)
        (self.root / "infra/retention").mkdir(parents=True)
        self.policy = gate.load_json(ROOT, gate.POLICY)
        real = gate.load_json(ROOT, gate.INVENTORY)
        self.inventory = {
            "inventoryVersion": 1,
            "policy": gate.POLICY,
            "profiles": copy.deepcopy(real["profiles"]),
            "stores": [
                {"id": "firestore:matters", "kind": "firestore", "name": "matters", "profile": "matter_record", "key": {"kind": "docId"}},
                {"id": "firestore:documents", "kind": "firestore", "name": "documents", "profile": "matter_content", "key": {"kind": "field", "field": "matterId"}},
                {"id": "firestore:audit_log", "kind": "firestore", "name": "audit_log", "profile": "audit_trail", "key": {"kind": "none"}},
                {"id": "objects:documents", "kind": "objectPrefix", "name": "documents", "profile": "vault_object", "key": {"kind": "objects", "via": "firestore:documents", "pathField": "storagePath"}},
                {"id": "postgres:judgment", "kind": "postgres", "name": "judgment", "profile": "public_corpus", "key": {"kind": "none"}},
                {"id": "backup:firestore", "kind": "backup", "name": "firestore", "profile": "backup", "key": {"kind": "backup", "windowDays": 98, "config": "infra/backup/firestore-backup.json"}},
            ],
        }
        self.write("firestore.rules", "service cloud.firestore {\n  match /databases/{database}/documents {\n    match /matters/{id} { allow read: if false; }\n    match /documents/{id} { allow read: if false; }\n  }\n}\n")
        self.write("functions/src/audit.ts", 'export const ref = () => db.collection("audit_log")\n')
        self.write("platform/documents/path.ts", "export const p = (firmId: string, id: string) => `s3://${firmId}/documents/${id}/v1`\n")
        self.write("postgres/ddl/001.sql", "CREATE TABLE IF NOT EXISTS judgment (id UUID PRIMARY KEY);\n")
        self.save()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def save(self) -> None:
        (self.root / gate.INVENTORY).write_text(json.dumps(self.inventory), encoding="utf-8")
        (self.root / gate.POLICY).write_text(json.dumps(self.policy), encoding="utf-8")

    def messages(self) -> list[str]:
        findings, _ = gate.run(self.root)
        return [f.message for f in findings]

    def test_baseline_passes(self) -> None:
        self.assertEqual(self.messages(), [])
        self.assertEqual(gate.main(["--root", str(self.root)]), 0)

    def test_a_new_rules_collection_fails(self) -> None:
        self.write("firestore.rules", (self.root / "firestore.rules").read_text().replace("  }\n}", "    match /matter_notes/{id} { allow read: if false; }\n  }\n}"))
        msgs = self.messages()
        self.assertTrue(any("uninventoried Firestore collection matter_notes (found in firestore.rules)" in m for m in msgs), msgs)
        self.assertEqual(gate.main(["--root", str(self.root)]), 1)

    def test_a_new_code_collection_fails_in_each_literal_form(self) -> None:
        for i, line in enumerate((
            'db.collection("new_a")',
            'getDocs(collection(db, "new_b"))',
            'getDoc(doc(db, "new_c", id))',
            'listAllRowsByFirm(db, "new_d", firmId)',
            'export const NEW_COLLECTION = "new_e"',
            'db.collectionGroup("new_f")',
        )):
            self.write(f"services/x{i}.ts", line + "\n")
        msgs = self.messages()
        for name in ("new_a", "new_b", "new_c", "new_d", "new_e", "new_f"):
            self.assertTrue(any(f"uninventoried Firestore collection {name} " in m for m in msgs), (name, msgs))

    def test_test_files_are_not_scanned(self) -> None:
        self.write("functions/test/x.test.ts", 'db.collection("only_in_a_test")\n')
        self.write("tests/y.test.ts", 'db.collection("only_in_a_test")\n')
        self.write("platform/z.test.ts", 'db.collection("only_in_a_test")\n')
        self.assertEqual(self.messages(), [])

    def test_a_new_object_prefix_fails(self) -> None:
        self.write("platform/documents/export.ts", "export const e = (firmId: string) => `s3://${firmId}/exports/x`\n")
        msgs = self.messages()
        self.assertTrue(any("uninventoried object key prefix exports" in m for m in msgs), msgs)

    def test_a_new_postgres_table_fails_from_ddl_and_from_a_model(self) -> None:
        self.write("postgres/ddl/002.sql", "create table if not exists matter_vectors (id int);\n")
        self.write("corpus_service/scraper/models.py", '__tablename__ = "client_embeddings"\n')
        msgs = self.messages()
        self.assertTrue(any("uninventoried Postgres table matter_vectors" in m for m in msgs), msgs)
        self.assertTrue(any("uninventoried Postgres table client_embeddings" in m for m in msgs), msgs)

    def test_a_stale_entry_fails_and_a_pending_one_passes_absent_and_present(self) -> None:
        self.inventory["stores"].append({"id": "firestore:gone", "kind": "firestore", "name": "gone", "profile": "matter_content", "key": {"kind": "field", "field": "matterId"}})
        self.save()
        self.assertTrue(any("stale inventory entry firestore:gone" in m for m in self.messages()))
        self.inventory["stores"][-1]["pending"] = "F34"
        self.save()
        self.assertEqual(self.messages(), [])
        self.write("functions/src/p1/decisions.ts", 'export const D = () => db.collection("gone")\n')
        findings, notes = gate.run(self.root)
        self.assertEqual(findings, [])
        self.assertTrue(any("pending on F34" in n for n in notes), notes)

    def test_malformed_entries_fail(self) -> None:
        cases = [
            ({"profile": "nope"}, "unknown profile nope"),
            ({"key": {"kind": "objects"}}, "key.kind must be one of"),
            ({"key": {"kind": "field"}}, "key.field is required"),
            ({"key": {"kind": "ttl"}}, "key.windowHours must be a positive integer"),
            ({"id": "firestore:other"}, "id must be firestore:documents"),
            ({"anonymise": {"matterId": True}}, "anonymise must map fields"),
            ({"ageField": {"field": "createdAt", "type": "date"}}, "ageField must be"),
            ({"pending": "soon"}, "pending must name a finding"),
        ]
        for patch, expected in cases:
            with self.subTest(expected=expected):
                saved = copy.deepcopy(self.inventory)
                self.inventory["stores"][1].update(patch)
                self.save()
                msgs = self.messages()
                self.assertTrue(any(expected in m for m in msgs), (expected, msgs))
                self.inventory = saved
                self.save()

    def test_a_duplicate_store_and_a_profile_without_an_answer_fail(self) -> None:
        self.inventory["stores"].append(copy.deepcopy(self.inventory["stores"][0]))
        self.inventory["profiles"]["matter_record"]["deleter"] = " "
        self.save()
        msgs = self.messages()
        self.assertTrue(any("duplicate store" in m for m in msgs), msgs)
        self.assertTrue(any("profile matter_record: deleter is required" in m for m in msgs), msgs)

    def test_policy_errors_fail(self) -> None:
        self.policy["classes"]["matter_content"]["onMatterDeletion"] = "shred"
        self.policy["classes"]["matter_record"]["legalHold"] = "yes"
        self.policy["classes"]["audit_trail"]["periodicAction"] = "purge"
        self.policy["status"] = "draft"
        self.save()
        msgs = self.messages()
        self.assertTrue(any("matter_content: onMatterDeletion must be one of" in m for m in msgs), msgs)
        self.assertTrue(any("matter_record: legalHold must be true or false" in m for m in msgs), msgs)
        self.assertTrue(any("audit_trail: a periodic deletion needs periodDays" in m for m in msgs), msgs)
        self.assertTrue(any("must say PROPOSED" in m for m in msgs), msgs)

    def test_a_class_that_may_anonymise_needs_the_fields(self) -> None:
        self.policy["classes"]["matter_content"]["onMatterDeletion"] = "anonymise"
        self.save()
        self.assertTrue(any("anonymise fields are required" in m for m in self.messages()))

    def test_a_backup_window_that_disagrees_with_f33_fails(self) -> None:
        self.inventory["stores"][-1]["key"]["windowDays"] = 30
        self.save()
        self.assertTrue(any("windowDays 30 disagrees" in m for m in self.messages()))


if __name__ == "__main__":
    unittest.main()
