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


class PlantedTree(unittest.TestCase):
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
        # The two rules blocks are server-only, so the code names them too (a server-only store must be visible in code).
        self.write("functions/src/matters.ts", 'export const m = () => db.collection("matters")\nexport const d = () => db.collection("documents")\n')
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



class Planted(PlantedTree):
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

    def test_a_new_postgres_view_fails_and_a_schema_qualified_name_is_read_whole(self) -> None:
        # FA-D5-003's views (postgres/ddl/005_research_reader.sql) are schema-qualified and use CREATE OR REPLACE.
        self.write(
            "postgres/ddl/005.sql",
            "CREATE OR REPLACE VIEW public.v_research_judgment WITH (security_barrier = true) AS SELECT 1;\n"
            "create materialized view if not exists matter_rollup as select 1;\n"
            'CREATE TABLE IF NOT EXISTS public."judgment_extra" (id int);\n',
        )
        msgs = self.messages()
        self.assertTrue(any("uninventoried Postgres table v_research_judgment" in m for m in msgs), msgs)
        self.assertTrue(any("uninventoried Postgres table matter_rollup" in m for m in msgs), msgs)
        self.assertTrue(any("uninventoried Postgres table judgment_extra" in m for m in msgs), msgs)
        self.assertFalse(any("uninventoried Postgres table public" in m for m in msgs), msgs)
        # Recorded as public corpus, out of matter-deletion scope: the tree passes.
        for name in ("v_research_judgment", "matter_rollup", "judgment_extra"):
            self.inventory["stores"].append({"id": f"postgres:{name}", "kind": "postgres", "name": name, "profile": "public_corpus", "key": {"kind": "none"}})
        self.save()
        self.assertEqual(self.messages(), [])

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

    def test_a_trace_export_store_names_field_keyed_sources_with_their_exported_states(self) -> None:
        good = {"source": "firestore:documents", "idField": "traceId", "statusField": "export.state", "exportedValues": ["exported", "pending"]}
        opik = {"id": "external:opik", "kind": "external", "name": "opik", "profile": "third_party_trace", "key": {"kind": "traceExport", "sources": [good]}}
        self.inventory["stores"].append(opik)
        self.save()
        self.assertEqual(self.messages(), [])
        cases = [
            ({"sources": []}, "key.sources must list at least one source"),
            ({"sources": [{**good, "source": "firestore:matters"}]}, "key.sources[0].source must name a field-keyed firestore store"),
            ({"sources": [{**good, "source": "firestore:nope"}]}, "key.sources[0].source must name a field-keyed firestore store"),
            ({"sources": [{**good, "idField": ""}]}, "key.sources[0].idField is required"),
            ({"sources": [good, {**good, "exportedValues": []}]}, "key.sources[1].exportedValues must list the exported states"),
        ]
        for patch, expected in cases:
            with self.subTest(expected=expected):
                opik["key"] = {"kind": "traceExport", **patch}
                self.save()
                msgs = self.messages()
                self.assertTrue(any(expected in m for m in msgs), (expected, msgs))

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

    def test_reason_codes_are_a_closed_list_of_codes(self) -> None:
        """FA-F42-R1-005 (spec R25): both lists exist, are non-empty, code-shaped and distinct."""
        for mutate, needle in (
            (lambda p: p["deletion"].pop("reasonCodes"), "deletion.reasonCodes"),
            (lambda p: p["deletion"].__setitem__("reasonCodes", []), "deletion.reasonCodes"),
            (lambda p: p["deletion"].__setitem__("reasonCodes", ["client_instruction", "Free text"]), "deletion.reasonCodes"),
            (lambda p: p["deletion"].__setitem__("reasonCodes", ["court_order", "court_order"]), "deletion.reasonCodes"),
            (lambda p: p.pop("legalHold"), "legalHold.reasonCodes"),
            (lambda p: p["legalHold"].__setitem__("reasonCodes", "litigation_anticipated"), "legalHold.reasonCodes"),
        ):
            policy = copy.deepcopy(self.policy)
            mutate(policy)
            findings = gate.check_policy(policy)
            self.assertTrue(any(needle in f.message for f in findings), msg=f"{needle}: {findings}")
        self.assertEqual(gate.check_policy(self.policy), [])

    def test_a_class_that_may_anonymise_needs_the_fields(self) -> None:
        self.policy["classes"]["matter_content"]["onMatterDeletion"] = "anonymise"
        self.save()
        self.assertTrue(any("anonymise fields are required" in m for m in self.messages()))

    def test_a_backup_window_that_disagrees_with_f33_fails(self) -> None:
        self.inventory["stores"][-1]["key"]["windowDays"] = 30
        self.save()
        self.assertTrue(any("windowDays 30 disagrees" in m for m in self.messages()))

    def test_a_deleting_period_must_cover_its_class_and_matter_closure_is_not_adoptable(self) -> None:
        """FA-F42-R1-011 (spec R31): no incoherent period can be ratified."""
        cls = self.policy["classes"]["matter_content"]
        cls.update({"periodDays": 30, "periodicAction": "purge", "legalHold": False})
        self.save()
        self.assertTrue(any("matter_content: a deleting period aged from matter closure is not built (FU-8)" in m for m in self.messages()))
        cls["periodBasis"] = "row_age"
        self.save()
        self.assertTrue(any("firestore:documents: its class matter_content has a deleting period, which retention.apply can age only" in m for m in self.messages()))
        self.inventory["stores"][1]["ageField"] = {"field": "uploadedAt", "type": "timestamp"}
        self.save()
        self.assertEqual(self.messages(), [])
        del cls["periodBasis"]
        self.save()
        self.assertTrue(any("matter_content: periodBasis must be one of" in m for m in self.messages()))

    def test_a_deleting_period_on_a_class_with_a_store_apply_cannot_age_fails(self) -> None:
        """FA-F42-R1-011 (spec R31): the vault (and any non-Firestore or unkeyed store) cannot take a deleting period."""
        self.policy["classes"]["vault_object"].update({"periodDays": 30, "periodicAction": "purge", "legalHold": False, "periodBasis": "row_age"})
        self.save()
        self.assertTrue(any("objects:documents: its class vault_object has a deleting period, which retention.apply can age only" in m for m in self.messages()))
        self.policy["classes"]["vault_object"].update({"periodicAction": "retain"})
        self.save()
        self.assertEqual(self.messages(), [])

    def test_the_approver_tenure_is_a_positive_whole_number_of_days(self) -> None:
        """FA-F42-R1-006 (spec R26): the gate refuses what validatePolicy refuses."""
        self.assertEqual(self.policy["deletion"]["approverMinTenureDays"], 30)
        for bad in (None, 0, 1.5, "30", True):
            policy = copy.deepcopy(self.policy)
            if bad is None:
                policy["deletion"].pop("approverMinTenureDays")
            else:
                policy["deletion"]["approverMinTenureDays"] = bad
            self.assertTrue(any("deletion.approverMinTenureDays" in f.message for f in gate.check_policy(policy)), bad)

    def test_a_server_only_collection_must_be_visible_in_code(self) -> None:
        """FA-F42-R1-008 (spec R28): a server-only rules block is no substitute for the code scan."""
        self.write("firestore.rules", (self.root / "firestore.rules").read_text().replace("  }\n}", "    match /hidden_store/{id} { allow read, write: if false; }\n  }\n}"))
        self.inventory["stores"].append({"id": "firestore:hidden_store", "kind": "firestore", "name": "hidden_store", "profile": "audit_trail", "key": {"kind": "none"}})
        self.save()
        msgs = self.messages()
        self.assertTrue(any("server-only Firestore collection hidden_store is found only through its firestore.rules block" in m for m in msgs), msgs)
        # Named in code (through a constant of any name), it passes.
        self.write("functions/src/hidden.ts", 'const STORE = "hidden_store"\nexport const h = () => adminDb().collection(STORE)\n')
        self.assertEqual(self.messages(), [])

    def test_a_dynamic_name_must_begin_an_inventoried_collection(self) -> None:
        self.write("functions/src/dyn.ts", "export const x = (db: any, k: string) => db.collection(`audit_${k}`)\n")
        self.assertEqual(self.messages(), [], msg="a prefix of an inventoried collection passes")
        self.write("functions/src/dyn.ts", "export const x = (db: any, k: string) => db.collection(`zz_new_${k}`)\n")
        self.assertTrue(any("dynamic Firestore collection name zz_new_..." in m for m in self.messages()))


# The re-auditor's 33 plant shapes at 301e65d (scratchpad reaudit-f42/gate_plants.py; 21 were missed): each must fail.
PLANT_TS = "functions/src/zz_audit_plant.ts"
PLANT_PLATFORM = "platform/zz_audit_plant.ts"
PLANT_SQL = "postgres/ddl/099_audit_plant.sql"
PLANT_PY = "corpus_service/zz_audit_plant.py"
AUDITOR_PLANTS = (
    # (id, files, rules addition, a substring the gate's findings must contain)
    ("P1", {PLANT_TS: 'import { adminDb } from "./admin"\nexport const x = () => adminDb().collection("audit_plant_new")\n'}, None, "audit_plant_new"),
    ("P2", {PLANT_TS: 'export const x = (db: any) => db.collection("matters").doc("m").collection("audit_plant_sub")\n'}, None, "audit_plant_sub"),
    ("P2r", {}, "    match /matters/{matterId}/audit_plant_notes/{noteId} { allow read: if false; }\n", "audit_plant_notes"),
    ("P2rn", {}, "    match /audit_plant_parent/{p} {\n      match /audit_plant_child/{c} { allow read: if false; }\n    }\n", "audit_plant_child"),
    ("P3", {PLANT_TS: 'export const x = (db: any) => db.collectionGroup("audit_plant_cg")\n'}, None, "audit_plant_cg"),
    ("P3m", {PLANT_TS: 'import { collectionGroup } from "firebase/firestore"\nexport const x = (firestore: any) => collectionGroup(firestore, "audit_plant_cg2")\n'}, None, "audit_plant_cg2"),
    ("P4", {PLANT_PLATFORM: "export const p = (firmId: string, id: string) => `s3://bucket/${firmId}/audit_plant_exports/${id}`\n"}, None, "audit_plant_exports"),
    ("P4b", {PLANT_PLATFORM: "export const p = (input: { firmId: string }, id: string) => `s3://bucket/${input.firmId}/audit_plant_exports2/${id}`\n"}, None, "audit_plant_exports2"),
    ("P4c", {PLANT_PLATFORM: 'export const p = (firmId: string, id: string) => "s3://bucket/" + firmId + "/audit_plant_exports3/" + id\n'}, None, "audit_plant_exports3"),
    ("P5", {PLANT_SQL: "CREATE TABLE IF NOT EXISTS audit_plant_tbl (id TEXT PRIMARY KEY, matter_id TEXT, body TEXT);\n"}, None, "audit_plant_tbl"),
    ("P5t", {PLANT_SQL: "CREATE TEMP TABLE audit_plant_tmp (id TEXT, body TEXT);\n"}, None, "audit_plant_tmp"),
    ("P5u", {PLANT_SQL: "CREATE UNLOGGED TABLE audit_plant_unl (id TEXT, body TEXT);\n"}, None, "audit_plant_unl"),
    ("P5s", {PLANT_SQL: "SELECT * INTO audit_plant_into FROM judgment;\n"}, None, "audit_plant_into"),
    ("P5o", {"corpus_service/migrations_audit_plant.sql": "CREATE TABLE audit_plant_elsewhere (id TEXT, body TEXT);\n"}, None, "audit_plant_elsewhere"),
    ("P5py", {PLANT_PY: 'DDL = "CREATE TABLE audit_plant_pyraw (id TEXT, body TEXT)"\n'}, None, "audit_plant_pyraw"),
    ("P6", {PLANT_SQL: "CREATE VIEW audit_plant_v AS SELECT 1;\n"}, None, "audit_plant_v"),
    ("P6m", {PLANT_SQL: "CREATE MATERIALIZED VIEW IF NOT EXISTS audit_plant_mv AS SELECT 1;\n"}, None, "audit_plant_mv"),
    ("B1", {PLANT_TS: 'export const x = (db: any, name: string) => db.collection(name)\nexport const y = (db: any) => x(db, "audit_plant_dyn_arg")\n'}, None, "audit_plant_dyn_arg"),
    ("B2a", {PLANT_TS: 'export const x = (db: any, k: string) => db.collection("audit_plant_" + k)\n'}, None, "audit_plant_"),
    ("B2b", {PLANT_TS: 'const P = "audit_plant"\nexport const x = (db: any) => db.collection(P + "_concat")\n'}, None, "audit_plant_concat"),
    ("B2c", {PLANT_TS: "export const x = (db: any) => db.collection(`audit_plant_tpl`)\n"}, None, "audit_plant_tpl"),
    ("B2d", {PLANT_TS: "export const x = (db: any, k: string) => db.collection(`audit_plant_${k}`)\n"}, None, "audit_plant_"),
    ("B2e", {PLANT_TS: 'const AUDIT_PLANT_STORE = "audit_plant_const"\nexport const x = (db: any) => db.collection(AUDIT_PLANT_STORE)\n'}, None, "audit_plant_const"),
    ("B2f", {PLANT_TS: 'export const x = (db: any) => db.collection("auditPlantCamel")\n'}, None, "auditPlantCamel"),
    ("B2g", {PLANT_TS: 'import { collection } from "firebase/firestore"\nexport const x = (firestore: any) => collection(firestore, "audit_plant_mod")\n'}, None, "audit_plant_mod"),
    ("B2h", {PLANT_TS: 'import { doc } from "firebase/firestore"\nexport class R { db: any; get(id: string) { return doc(this.db, "audit_plant_this", id) } }\n'}, None, "audit_plant_this"),
    ("B2i", {"functions/src/zz_audit_plant.js": 'exports.x = (db) => db.collection("audit_plant_js")\n'}, None, "audit_plant_js"),
    ("B2j", {"scripts/zz_audit_plant.cjs": 'module.exports = (db) => db.collection("audit_plant_cjs")\n'}, None, "audit_plant_cjs"),
    ("B2k", {"components/zz_audit_plant.ts": 'export const x = (db: any) => db.collection("audit_plant_comp")\n'}, None, "audit_plant_comp"),
    ("B2l", {PLANT_PY: 'def f(db):\n    return db.collection("audit_plant_py")\n'}, None, "audit_plant_py"),
    ("B3", {PLANT_SQL: "CREATE TABLE IF NOT EXISTS client_private.judgment (id TEXT PRIMARY KEY, matter_id TEXT, privileged_text TEXT);\n"}, None, "client_private.judgment"),
    ("B3b", {PLANT_SQL: 'CREATE OR REPLACE VIEW "firm_private"."v_judgment" AS SELECT 1;\n'}, None, "firm_private.v_judgment"),
    ("B3c", {PLANT_SQL: "CREATE TABLE app.audit_plant_q (id TEXT);\n"}, None, "app.audit_plant_q"),
    ("P34", {PLANT_TS: 'export const x = (db: any) => db.doc("audit_plant_doclit/m1")\n'}, None, "audit_plant_doclit"),
    ("P35", {PLANT_TS: 'export const x = (db: any, id: string) => db.doc(`audit_plant_doctpl/${id}`)\n'}, None, "audit_plant_doctpl"),
    ("P36", {PLANT_PY: 'def f(db):\n    return db.document("audit_plant_pydoc/d1")\n'}, None, "audit_plant_pydoc"),
    ("P37", {PLANT_SQL: "ALTER TABLE judgment RENAME TO audit_plant_pgrename;\n"}, None, "audit_plant_pgrename"),
)


class AuditorPlants(PlantedTree):
    """FA-F42-R1-008: every shape the re-auditor planted is a must-fail fixture (and the clean tree passes)."""

    def setUp(self) -> None:
        super().setUp()
        # The public corpus names the B3 plants collide with, and the view P5s reads, are inventoried as public corpus.
        self.inventory["stores"].append({"id": "postgres:v_judgment", "kind": "postgres", "name": "v_judgment", "profile": "public_corpus", "key": {"kind": "none"}})
        self.write("postgres/ddl/002_views.sql", "CREATE OR REPLACE VIEW public.v_judgment AS SELECT 1;\n")
        self.save()

    def test_the_clean_tree_passes(self) -> None:
        self.assertEqual(self.messages(), [])

    def test_every_planted_shape_fails_the_gate_and_names_the_store(self) -> None:
        self.assertEqual(len(AUDITOR_PLANTS), 37)
        rules = self.root / "firestore.rules"
        clean = rules.read_text(encoding="utf-8")
        for pid, files, rules_extra, needle in AUDITOR_PLANTS:
            with self.subTest(plant=pid):
                written = []
                try:
                    for rel, text in files.items():
                        self.write(rel, text)
                        written.append(self.root / rel)
                    if rules_extra:
                        rules.write_text(clean.replace("  }\n}", rules_extra + "  }\n}"), encoding="utf-8")
                    msgs = self.messages()
                    self.assertTrue(any(needle in m for m in msgs), msg=f"{pid}: {msgs}")
                    self.assertEqual(gate.main(["--root", str(self.root)]), 1)
                finally:
                    for p in written:
                        p.unlink()
                    rules.write_text(clean, encoding="utf-8")
        self.assertEqual(self.messages(), [])


class RuntimeCheck(unittest.TestCase):
    """FA-F42-R1-008: the run-time check compares the emulator's root collections with the inventory."""

    def test_an_uninventoried_root_collection_fails_and_test_fixtures_are_named(self) -> None:
        inventory = gate.load_json(ROOT, gate.INVENTORY)
        findings = gate.check_runtime_collections(["matters", "documents", "zz_unknown_store", *gate.RUNTIME_TEST_COLLECTIONS], inventory)
        self.assertEqual([f.message for f in findings], [
            "run-time: Firestore collection zz_unknown_store exists after the emulator suite but is not inventoried; add it to infra/retention/inventory.json",
        ])
        self.assertEqual(gate.check_runtime_collections(["matters"], inventory), [])


if __name__ == "__main__":
    unittest.main()
