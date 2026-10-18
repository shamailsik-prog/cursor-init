"""Audit F21: the lifecycle's rules, without a database.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R2, R3, R4, R12).

* The transition table is the spec's, written out here, not imported from the code under test.
* ``lifecycle.move`` refuses an illegal move before anything is written, and records a legal one.
* The database CHECKs are built from the same table.
* The four consumers are registered on the real beat schedule.
* No source task writes a master table, and no route is ``direct`` (the F21 direct-write gate),
  with mutants that put a write back.
* Only ``lifecycle.move`` (and migration 005's backfill) assigns ``lifecycle_state``.
"""

import ast
import shutil
import unittest
from pathlib import Path

from test_trust_policy import PROJECT_ROOT, corpus_modules, scan_source_for_master_tables

SPEC_MOVES = {
    "discovered": {"downloaded", "failed", "duplicate", "dead_letter"},
    "downloaded": {"parsed", "failed", "duplicate", "dead_letter"},
    "parsed": {"normalised", "failed", "duplicate", "dead_letter"},
    "normalised": {"quarantined", "approved", "dead_letter"},
    "quarantined": {"approved", "rejected", "dead_letter"},
    "approved": {"published", "dead_letter"},
    "published": {"embedded", "dead_letter"},
    "embedded": set(),
    "rejected": set(),
    "duplicate": set(),
    "failed": set(),
    "dead_letter": set(),
}
NEEDS_REASON = {"failed", "duplicate", "rejected", "dead_letter"}
BEAT = {
    "normalise-corpus": ("scraper.tasks.corpus_pipeline.normalise_corpus", 300),
    "promote-corpus": ("scraper.tasks.corpus_pipeline.promote_corpus", 300),
    "publish-corpus": ("scraper.tasks.corpus_pipeline.publish_corpus", 300),
    "reconcile-corpus": ("scraper.tasks.corpus_pipeline.reconcile_corpus", 3600),
}
# The only modules that may write a master table (R12): the retrieval projection and F23's route.
MASTER_WRITERS = {"scraper.publication.retrieval", "scraper.routers.quarantine"}
# Updaters of rows already in a master table (F20's reviewed list); their scanned writes stay empty.
MASTER_UPDATERS = {"scraper.tasks.embeddings", "scraper.tasks.cross_reference"}
STATE_WRITERS = {"scraper.tasks.lifecycle", "migrations.005_corpus_lifecycle"}


class _Row:
    __tablename__ = "statutes_staging"

    def __init__(self, state):
        self.id = "00000000-0000-4000-8000-000000000021"
        self.lifecycle_state = state
        self.state_reason = None
        self.state_changed_at = None


class _Db:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)


class TransitionTableTests(unittest.TestCase):
    def test_the_transition_table_is_the_spec_table(self):
        from scraper.tasks import lifecycle

        self.assertEqual({k: set(v) for k, v in lifecycle.LEGAL_MOVES.items()}, SPEC_MOVES)
        self.assertEqual(set(lifecycle.STATES), set(SPEC_MOVES))
        self.assertEqual(set(lifecycle.TERMINAL_STATES), {s for s, out in SPEC_MOVES.items() if not out})
        self.assertEqual(set(lifecycle.REASON_REQUIRED), NEEDS_REASON)
        for src, outs in SPEC_MOVES.items():
            for dst in SPEC_MOVES:
                self.assertEqual(lifecycle.is_legal(src, dst), dst in outs, (src, dst))

    def test_move_refuses_an_illegal_move_before_anything_is_written(self):
        from scraper.tasks import lifecycle

        for src, dst in (("parsed", "approved"), ("quarantined", "published"), ("embedded", "dead_letter"),
                         ("rejected", "approved"), ("parsed", "parsed"), ("normalised", "nonsense")):
            row, db = _Row(src), _Db()
            with self.assertRaises(lifecycle.IllegalTransition, msg=(src, dst)):
                lifecycle.move(db, row, dst, actor="test", reason="r")
            self.assertEqual((row.lifecycle_state, db.added), (src, []), (src, dst))

    def test_move_refuses_a_terminal_bad_state_without_a_reason(self):
        from scraper.tasks import lifecycle

        for dst in sorted(NEEDS_REASON - {"rejected"}):
            row, db = _Row("parsed"), _Db()
            with self.assertRaises(lifecycle.IllegalTransition, msg=dst):
                lifecycle.move(db, row, dst, actor="test")
            self.assertEqual((row.lifecycle_state, db.added), ("parsed", []))

    def test_move_records_the_move_with_its_run(self):
        from scraper.models import CorpusLifecycleTransition
        from scraper.tasks import lifecycle

        row, db = _Row("normalised"), _Db()
        lifecycle.move(db, row, "quarantined", actor="gate", job_id="job-1", reason="review_source", details={"k": 1})
        self.assertEqual((row.lifecycle_state, row.state_reason), ("quarantined", "review_source"))
        self.assertIsNotNone(row.state_changed_at)
        (logged,) = db.added
        self.assertIsInstance(logged, CorpusLifecycleTransition)
        self.assertEqual(
            (logged.record_table, logged.record_id, logged.from_state, logged.to_state, logged.actor, logged.job_id,
             logged.reason, logged.details),
            ("statutes_staging", row.id, "normalised", "quarantined", "gate", "job-1", "review_source", {"k": 1}),
        )

    def test_the_database_checks_are_built_from_the_same_table(self):
        from scraper import models
        from scraper.tasks import lifecycle

        def checks(table):
            return {c.name: str(c.sqltext) for c in table.constraints if c.__class__.__name__ == "CheckConstraint"}

        for model, prefix in ((models.ScraperStaging, "ck_staging"), (models.StatutesStaging, "ck_statutes_staging")):
            found = checks(model.__table__)
            states = found[f"{prefix}_lifecycle_state"]
            self.assertTrue(all(f"'{s}'" in states for s in SPEC_MOVES), states)
            reason = found[f"{prefix}_lifecycle_reason"]
            self.assertTrue(all(f"'{s}'" in reason for s in NEEDS_REASON), reason)
        log = checks(models.CorpusLifecycleTransition.__table__)["ck_lifecycle_transition_legal"]
        pairs = {f"'{a}>{b}'" for a, outs in SPEC_MOVES.items() for b in outs}
        self.assertTrue(all(p in log for p in pairs), log)
        self.assertEqual(log.count(">"), len(pairs), "the CHECK lists a pair the spec does not")
        self.assertEqual(lifecycle.legal_pairs_sql().count(">"), len(pairs))


class BeatScheduleTests(unittest.TestCase):
    def test_the_four_consumers_are_scheduled_and_registered(self):
        from scraper.tasks import celery_app

        schedule = celery_app.app.conf.beat_schedule
        got = {name: (schedule[name]["task"], schedule[name]["schedule"]) for name in BEAT if name in schedule}
        self.assertEqual(got, BEAT)
        for task, _every in BEAT.values():
            self.assertIn(task, celery_app.app.tasks)
        # Pipeline order inside the schedule (a test tick fires them in this order).
        order = [name for name in schedule if name in BEAT]
        self.assertEqual(order, list(BEAT))


# ---------------------------------------------------------------------------------------------
# R12: the direct-write gate
# ---------------------------------------------------------------------------------------------
def direct_write_violations(root=PROJECT_ROOT, routes=None):
    """{where: reasons}: a dispatcher route declared `direct`; a module under scraper/tasks/ that
    writes a master table (updaters included: their writes must stay empty); any other module that
    writes one without being the retrieval projection or F23's route."""
    if routes is None:
        from scraper.tasks import dispatcher

        routes = dispatcher.ROUTES
    found = {}
    direct = sorted(name for name, route in routes.items() if isinstance(route, tuple) and len(route) == 3 and route[2] == "direct")
    if direct:
        found["dispatcher.ROUTES"] = [f"direct route {name}" for name in direct]
    for module, path in corpus_modules(root):
        if module == "scraper.models":
            continue
        writes = scan_source_for_master_tables(path.read_text(), module)["writes"]
        if not writes:
            continue
        if module.startswith("scraper.tasks.") or module not in MASTER_WRITERS:
            found[module] = sorted(writes)
    return found


class DirectWriteGateTests(unittest.TestCase):
    def test_no_source_task_writes_a_master_table_and_no_route_is_direct(self):
        self.assertEqual(direct_write_violations(), {})

    def test_the_gate_is_not_vacuous(self):
        """It sees the writers that are allowed, so an empty answer means something."""
        writers = {m for m, p in corpus_modules() if m != "scraper.models"
                   and scan_source_for_master_tables(p.read_text(), m)["writes"]}
        self.assertEqual(writers, MASTER_WRITERS)

    def test_mutants_that_put_a_direct_write_back_are_caught(self):
        import tempfile

        from scraper.tasks import dispatcher

        mutants = {
            "pakistancode_orm": ("scraper/tasks/pakistancode.py",
                                 "\nfrom scraper.models import StatutesMaster\n\ndef _m(db):\n    db.add(StatutesMaster(statute_name='x'))\n"),
            "shc_sql": ("scraper/tasks/shc.py",
                        "\nfrom sqlalchemy import text\n_M = text(\"INSERT INTO case_law_master (citation) VALUES ('x')\")\n"),
            "new_source": ("scraper/tasks/f21_new_source.py",
                           "from scraper.models import CaseLawMaster as C\nasync def scrape(source, db):\n    db.add(C())\n"),
            "updater_gains_insert": ("scraper/tasks/cross_reference.py",
                                     "\nfrom sqlalchemy import insert\n_M = insert(CaseLawMaster)\n"),
            "helper_outside_publication": ("scraper/f21_helper.py",
                                           "from scraper.models import StatutesMaster\nStatutesMaster()\n"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            for name, (rel, extra) in mutants.items():
                root = Path(tmp) / name
                shutil.copytree(PROJECT_ROOT / "scraper", root / "scraper", ignore=shutil.ignore_patterns("__pycache__"))
                target = root / rel
                target.write_text((target.read_text() if target.exists() else "") + extra)
                module = ".".join(Path(rel).with_suffix("").parts)
                self.assertIn(module, direct_write_violations(root), name)
        routes = dict(dispatcher.ROUTES)
        routes["PakistanCode"] = ("scraper.tasks.pakistancode", "scrape_pakistancode", "direct")
        self.assertEqual(direct_write_violations(routes=routes).get("dispatcher.ROUTES"), ["direct route PakistanCode"])


# ---------------------------------------------------------------------------------------------
# R3: one writer of the state
# ---------------------------------------------------------------------------------------------
def state_assignments(source):
    """Lines that assign lifecycle_state: an attribute or keyword assignment, or SQL that sets it."""
    tree = ast.parse(source)
    lines = set()
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        for target in targets:
            if isinstance(target, ast.Attribute) and target.attr == "lifecycle_state":
                lines.add(node.lineno)
        if isinstance(node, ast.Call):
            if any(k.arg == "lifecycle_state" for k in node.keywords):
                lines.add(node.lineno)
            if isinstance(node.func, ast.Name) and node.func.id == "setattr" and len(node.args) >= 2 \
                    and isinstance(node.args[1], ast.Constant) and node.args[1].value == "lifecycle_state":
                lines.add(node.lineno)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            text = " ".join(node.value.split()).lower()
            if "set lifecycle_state" in text or ", lifecycle_state =" in text or " lifecycle_state = '" in text:
                lines.add(node.lineno)
    return sorted(lines)


class SingleStateWriterTests(unittest.TestCase):
    def test_only_lifecycle_move_and_migration_005_assign_the_state(self):
        writers = {m: state_assignments(p.read_text()) for m, p in corpus_modules() if m != "scraper.models"}
        writers = {m: lines for m, lines in writers.items() if lines}
        self.assertEqual(set(writers), STATE_WRITERS, writers)

    def test_the_scan_sees_every_shape(self):
        caught = {
            "attribute": "st.lifecycle_state = 'approved'\n",
            "keyword": "ScraperStaging(lifecycle_state='embedded')\n",
            "setattr": "setattr(st, 'lifecycle_state', 'approved')\n",
            "sql": "text(\"UPDATE scraper_staging SET lifecycle_state = 'published' WHERE id = :i\")\n",
            "sql_list": "text(\"UPDATE statutes_staging SET normalised = true, lifecycle_state = 'normalised'\")\n",
        }
        self.assertEqual({n for n, src in caught.items() if not state_assignments(src)}, set())
        quiet = {"read": "if st.lifecycle_state == 'parsed': pass\n",
                 "select": "text(\"SELECT lifecycle_state FROM scraper_staging\")\n"}
        self.assertEqual({n for n, src in quiet.items() if state_assignments(src)}, set())


if __name__ == "__main__":
    unittest.main()
