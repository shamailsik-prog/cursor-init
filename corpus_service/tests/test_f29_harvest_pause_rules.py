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
        if isinstance(node, ast.FunctionDef) and node.name == "process_embedding_queue_task":
            body = ast.unparse(ast.Module(body=node.body, type_ignores=[]))
            assert "harvest_control" in body and "is_paused" in body, body
            return
    raise AssertionError("process_embedding_queue_task not found")


def test_admin_start_stop_use_harvest_control():
    root = pathlib.Path(__file__).resolve().parents[1] / "scraper" / "main.py"
    text = root.read_text()
    assert "harvest_control.pause()" in text
    assert "harvest_control.resume()" in text
    assert "harvest.stopped" not in text
