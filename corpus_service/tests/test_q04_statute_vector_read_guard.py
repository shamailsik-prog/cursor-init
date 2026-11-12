"""RESID-SEMANTIC-WIRING-001. Fail closed if a future module reads statute vectors.

There is still no semantic reader. This guard does not add one. It AST-scans and
text-scans every ``.py`` under ``corpus_service/`` except ``tests/`` and flags a
module that:

* references ``StatutesMaster.embedding`` (attribute access, including a module alias);
* selects or orders by statute vectors in a SQL string (``statutes_master`` together
  with ``embedding``, or ``record_embedding_chunks`` together with ``<=>``, ``<->``,
  ``<#>``, ``cosine`` or ``l2_distance``);
* calls ``.cosine_distance(``, ``.l2_distance(`` or ``.max_inner_product(`` on a
  statute embedding column.

Real hits on main (re-checked by ``test_the_clean_tree_has_only_allowlisted_hits``):

* ``scraper/publication/retrieval.py`` ``live_statute_semantic_stmt`` references
  ``StatutesMaster.embedding`` in the sanctioned select. That statement is the only
  reader shape, and nothing calls it from production code.
* ``withdraw_statute_embeddings`` in the same file clears ``embedding`` with a
  keyword assignment. It does not reference ``StatutesMaster.embedding`` and it
  does not order by a vector. It is allowlisted because it is the withdrawal writer.
* ``scraper/models.py`` declares the ``embedding`` column and the HNSW cosine index.
  Those are schema strings, not a select of ``statutes_master`` together with
  ``embedding``, so this scan does not flag them. The file stays allowlisted as schema.
* ``scraper/migrate.py`` and ``migrations/**`` are the DDL runner and DDL. No hit.
* ``scraper/tasks/embeddings.py`` writes the chunk-0 vector with
  ``update(master).values(embedding=vector)`` and inserts ``record_embedding_chunks``.
  The insert names the chunk table and the column; it does not use a distance
  operator. No hit. The file stays allowlisted as the writer.
* ``scraper/tasks/embedding_chunks.py`` builds chunk text. No vector read. No hit.
  It stays allowlisted as the writer helper.
"""

from __future__ import annotations

import ast
import shutil
import tempfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Exact allowlist. A reason is recorded for every entry, including files this
# scan does not currently flag, so a later writer in those files stays sanctioned.
ALLOWLIST = {
    "scraper/models.py": "schema: StatutesMaster.embedding column and its HNSW index",
    "scraper/migrate.py": "DDL runner",
    "scraper/tasks/embeddings.py": "writer: stores the master vector and chunk rows",
    "scraper/tasks/embedding_chunks.py": "writer helper: chunk text, no vector read",
}
MIGRATIONS_PREFIX = "migrations/"
SANCTIONED_FUNCTIONS = frozenset({"live_statute_semantic_stmt", "withdraw_statute_embeddings"})
RETRIEVAL = "scraper/publication/retrieval.py"
DISTANCE_CALLS = frozenset({"cosine_distance", "l2_distance", "max_inner_product"})
DISTANCE_MARKERS = ("<=>", "<->", "<#>", "cosine", "l2_distance")


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _allowed(rel: str, functions: tuple) -> bool:
    if rel in ALLOWLIST or rel.startswith(MIGRATIONS_PREFIX):
        return True
    if rel == RETRIEVAL and SANCTIONED_FUNCTIONS.intersection(functions):
        return True
    return False


def _statute_names(tree: ast.AST) -> set:
    names = {"StatutesMaster"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "StatutesMaster":
                    names.add(alias.asname or alias.name)
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            value = node.value
            if isinstance(value, ast.Name) and value.id in names:
                names.add(node.targets[0].id)
            if isinstance(value, ast.Attribute) and value.attr == "StatutesMaster":
                names.add(node.targets[0].id)
    return names


def _is_statute_embedding(node: ast.AST, names: set) -> bool:
    if not isinstance(node, ast.Attribute) or node.attr != "embedding":
        return False
    value = node.value
    if isinstance(value, ast.Name) and value.id in names:
        return True
    return isinstance(value, ast.Attribute) and value.attr == "StatutesMaster"


def _call_on_statute_embedding(node: ast.AST, names: set) -> bool:
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
        return False
    if node.func.attr not in DISTANCE_CALLS:
        return False
    current = node.func.value
    while isinstance(current, ast.Attribute):
        if _is_statute_embedding(current, names):
            return True
        current = current.value
    return False


def _string_text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _near(text: str, left: str, right: str, window: int = 240) -> bool:
    """True when ``left`` and ``right`` occur together in one short span of ``text``."""
    folded = text.lower()
    start = 0
    while True:
        at = folded.find(left, start)
        if at < 0:
            return False
        span = folded[max(0, at - window): at + len(left) + window]
        if right in span:
            return True
        start = at + len(left)


def _sql_kind(text: str) -> str | None:
    folded = text.lower()
    if ("select" in folded or "order by" in folded) and _near(folded, "statutes_master", "embedding"):
        return "sql-statutes-master"
    if any(_near(folded, "record_embedding_chunks", marker.lower()) for marker in DISTANCE_MARKERS):
        return "sql-chunks"
    return None


def scan_tree(root: Path) -> list:
    """Every statute-vector hit under ``root``, tests excluded."""
    hits = []
    for path in sorted(root.rglob("*.py")):
        rel = _rel(root, path)
        if rel == "tests" or rel.startswith("tests/") or "/tests/" in f"/{rel}":
            continue
        if "__pycache__" in rel:
            continue
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source)
        except (SyntaxError, UnicodeError) as exc:
            hits.append({"path": rel, "line": 1, "function": "", "kind": "unparsed", "allowed": False, "detail": str(exc)})
            continue
        names = _statute_names(tree)
        found = []

        class Visitor(ast.NodeVisitor):
            def __init__(self):
                self.stack = []

            def visit_FunctionDef(self, node):
                self.stack.append(node.name)
                self.generic_visit(node)
                self.stack.pop()

            visit_AsyncFunctionDef = visit_FunctionDef

            def _record(self, kind, node):
                functions = tuple(self.stack)
                found.append({
                    "path": rel,
                    "line": getattr(node, "lineno", 1),
                    "function": functions[-1] if functions else "",
                    "kind": kind,
                    "allowed": _allowed(rel, functions),
                    "detail": kind,
                })

            def visit_Attribute(self, node):
                if _is_statute_embedding(node, names):
                    self._record("attribute", node)
                self.generic_visit(node)

            def visit_Call(self, node):
                if _call_on_statute_embedding(node, names):
                    self._record("distance-call", node)
                self.generic_visit(node)

            def visit_Constant(self, node):
                text = _string_text(node)
                kind = _sql_kind(text) if text else None
                if kind:
                    self._record(kind, node)
                self.generic_visit(node)

        Visitor().visit(tree)
        hits.extend(found)
    return hits


def violations(hits) -> list:
    return [hit for hit in hits if not hit["allowed"]]


def test_the_clean_tree_has_only_allowlisted_hits():
    hits = scan_tree(PROJECT_ROOT)
    bad = violations(hits)
    assert bad == [], bad
    sanctioned = [hit for hit in hits if hit["path"] == RETRIEVAL]
    assert sanctioned, "live_statute_semantic_stmt must reference StatutesMaster.embedding"
    assert all(hit["function"] == "live_statute_semantic_stmt" for hit in sanctioned)
    assert all(hit["kind"] in {"attribute", "distance-call"} for hit in sanctioned)
    # The other allowlist entries are schema, DDL or writers. A hit in one of them
    # would still be allowed; today the clean tree has none outside the statement.
    elsewhere = [hit for hit in hits if hit["path"] != RETRIEVAL]
    assert elsewhere == [], elsewhere


def test_a_rogue_reader_is_flagged_and_the_sanctioned_statement_is_not():
    """PublicCorpusReadGuardTests copytree pattern. A rogue module is flagged.
    The same read inside ``live_statute_semantic_stmt`` is not."""
    rogue = (
        "from scraper.models import StatutesMaster\n"
        "from sqlalchemy import select, text\n"
        "\n"
        "def rank(q):\n"
        "    return select(StatutesMaster.id).order_by(StatutesMaster.embedding.cosine_distance(q))\n"
        "\n"
        "RAW = text(\"SELECT id FROM statutes_master ORDER BY embedding <=> :q\")\n"
        "CHUNKS = text(\"SELECT record_id FROM record_embedding_chunks ORDER BY embedding <-> :q\")\n"
    )
    planted = (
        "\n    q = None\n"
        "    select(StatutesMaster.id).order_by(StatutesMaster.embedding.cosine_distance(q))\n"
        "    text(\"SELECT id FROM statutes_master ORDER BY embedding <=> :q\")\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "corpus_service"
        shutil.copytree(PROJECT_ROOT, root, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        tasks = root / "scraper" / "tasks"
        (tasks / "rogue_semantic.py").write_text(rogue)
        retrieval = root / "scraper" / "publication" / "retrieval.py"
        source = retrieval.read_text(encoding="utf-8")
        needle = "def live_statute_semantic_stmt():\n"
        assert needle in source
        # Insert the rogue read as the first statements of the sanctioned function,
        # after its docstring, and also as a new function the allowlist must reject.
        start = source.index(needle)
        doc_end = source.index('"""', source.index('"""', start) + 3) + 3
        source = (
            source[:doc_end]
            + planted
            + source[doc_end:]
            + "\n\ndef rogue_reader(q):\n"
            + "    return select(StatutesMaster.id).order_by(StatutesMaster.embedding.cosine_distance(q))\n"
        )
        retrieval.write_text(source)
        hits = scan_tree(root)
        rogue_hits = [hit for hit in hits if hit["path"] == "scraper/tasks/rogue_semantic.py"]
        kinds = {hit["kind"] for hit in rogue_hits}
        assert "attribute" in kinds or "distance-call" in kinds
        assert "sql-statutes-master" in kinds
        assert "sql-chunks" in kinds
        assert all(not hit["allowed"] for hit in rogue_hits)
        retrieval_bad = [
            hit for hit in violations(hits) if hit["path"] == RETRIEVAL and hit["function"] == "live_statute_semantic_stmt"
        ]
        assert retrieval_bad == []
        rogue_fn = [hit for hit in violations(hits) if hit["path"] == RETRIEVAL and hit["function"] == "rogue_reader"]
        assert rogue_fn, "a new function in retrieval.py must be flagged"
