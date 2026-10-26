"""Audit F29 structural rules: scheduled harvest consumers must read harvest_control."""

import ast
import pathlib


def _function_body(module_path: pathlib.Path, name: str) -> ast.AST:
    tree = ast.parse(module_path.read_text())
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.Module(body=node.body, type_ignores=[])
    raise AssertionError(f"{name} not found in {module_path}")


def test_dispatcher_run_async_checks_harvest_pause():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "tasks" / "dispatcher.py"
    body = ast.unparse(_function_body(root, "_run_async"))
    assert "harvest_control" in body and "is_paused" in body, body


def test_embedding_scheduled_task_checks_harvest_pause():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "tasks" / "embeddings.py"
    tree = ast.parse(root.read_text())
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run_embedding_batch":
            body = ast.unparse(ast.Module(body=node.body, type_ignores=[]))
            assert "harvest_control" in body and "is_paused_async" in body, body
            return
    raise AssertionError("run_embedding_batch not found")


def test_admin_start_stop_use_harvest_control():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "main.py"
    text = root.read_text()
    assert "harvest_control.pause_async()" in text
    assert "harvest_control.resume_async()" in text
    assert "harvest.stopped" not in text


def test_harvest_control_status_exposes_in_flight_work():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "main.py"
    text = root.read_text()
    assert "operator_status_async()" in text
    hc = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "harvest_control.py"
    body = hc.read_text()
    assert "operator_status_async" in body and "ScraperJob" in body and "in_flight" in body


def test_harvest_control_is_db_backed_not_file_authoritative():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "harvest_control.py"
    text = root.read_text()
    assert "HarvestOperatorState" in text
    assert "harvest_operator_state" in text
    assert "SessionLocal" in text
    # Legacy file may be adopted once; scheduled work must not treat the file as the source of truth.
    assert "is_paused_async" in text
