"""Audit F31 review round (Copilot thread 4305672181): tests/e2e/runtime_smoke.sh resolves
F31_RUNTIME_VENV to an absolute path before it builds the venv.

The script creates the venv, then `cd`s into corpus_service/ and runs the smoke with the venv's
interpreter. A relative path (".venv-f31" from the repo root) or a "~" path used to be created
relative to the caller and then looked up relative to corpus_service/, so the run failed.

These tests drive the real script with a stand-in interpreter (PYTHON) that records what the
script asks of it and makes a fake venv whose bin/python is the same stand-in. No packages are
installed and no database is touched; the real e2e is the script itself (job corpus-runtime).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "tests" / "e2e" / "runtime_smoke.sh"

_STUB = """#!/usr/bin/env bash
# Stand-in interpreter for runtime_smoke.sh: records each call, builds a fake venv.
if [ "$1" = "--version" ]; then echo "Python 3.12.0 (stand-in)"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin" && cp "$0" "$3/bin/python" && echo "venv $3" >> "$F31_STUB_LOG"; exit $?
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then echo "pip $3 via $0" >> "$F31_STUB_LOG"; exit 0; fi
echo "run $1 via $0 in $PWD" >> "$F31_STUB_LOG"
"""


@pytest.fixture
def harness(tmp_path):
    stub = tmp_path / "stand-in-python"
    stub.write_text(_STUB, encoding="utf-8")
    stub.chmod(0o755)
    caller = tmp_path / "caller"
    caller.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    log = tmp_path / "calls.log"

    def run(venv_value=None, *, unset=False):
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(home),
            "TMPDIR": str(tmp_path),
            "PYTHON": str(stub),
            "F31_STUB_LOG": str(log),
            "CORPUS_TEST_DATABASE_URL": "postgresql+asyncpg://unused@127.0.0.1:1/unused",
        }
        if not unset:
            env["F31_RUNTIME_VENV"] = venv_value
        proc = subprocess.run(["bash", str(SCRIPT)], cwd=str(caller), env=env, capture_output=True, text=True, timeout=60)
        calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        return proc, calls

    return run, caller, home, tmp_path


def _assert_ran_with(proc, calls, venv: Path):
    assert proc.returncode == 0, (proc.returncode, proc.stdout, proc.stderr, calls)
    python = venv / "bin" / "python"
    assert calls[0] == f"venv {venv}", calls
    assert f"pip install via {python}" in calls, calls
    assert calls[-1] == f"run tests/e2e/runtime_smoke.py via {python} in {PROJECT_ROOT}", calls


def test_relative_venv_path_resolves_against_the_callers_directory(harness):
    run, caller, _home, _tmp = harness
    proc, calls = run(".venv-f31")
    _assert_ran_with(proc, calls, caller / ".venv-f31")
    assert (caller / ".venv-f31" / "bin" / "python").is_file()
    assert not (PROJECT_ROOT / ".venv-f31").exists(), "the venv must never land inside corpus_service/"


def test_nested_relative_venv_path(harness):
    run, caller, _home, _tmp = harness
    proc, calls = run("build/../venvs/f31")
    _assert_ran_with(proc, calls, caller / "build/../venvs/f31")
    assert (caller / "venvs" / "f31" / "bin" / "python").is_file()


@pytest.mark.parametrize("value, under_home", [("~/f31-venv", "f31-venv"), ("~", None)])
def test_tilde_venv_path_expands_to_home(harness, value, under_home):
    run, caller, home, _tmp = harness
    if under_home is None:
        shutil.rmtree(home)  # "~" itself must not exist yet
        target = home
    else:
        target = home / under_home
    proc, calls = run(value)
    _assert_ran_with(proc, calls, target)
    assert not (caller / "~").exists(), "a literal '~' directory must never be created"


def test_absolute_venv_path(harness):
    run, _caller, _home, tmp_path = harness
    target = tmp_path / "abs" / "venv"
    proc, calls = run(str(target))
    _assert_ran_with(proc, calls, target)


def test_existing_venv_path_is_refused_after_resolution(harness):
    run, caller, _home, _tmp = harness
    (caller / "taken").mkdir()
    proc, calls = run("taken")
    assert proc.returncode == 2 and "already exists" in proc.stdout, (proc.stdout, proc.stderr)
    assert str(caller / "taken") in proc.stdout
    assert calls == []


def test_tilde_user_form_is_refused(harness):
    run, _caller, _home, _tmp = harness
    proc, calls = run("~someone-else/f31")
    assert proc.returncode == 2 and "~user" in proc.stdout, (proc.stdout, proc.stderr)
    assert calls == []


def test_default_venv_is_temporary_and_removed(harness):
    run, _caller, _home, tmp_path = harness
    proc, calls = run(unset=True)
    assert proc.returncode == 0, (proc.stdout, proc.stderr, calls)
    venv = Path(calls[0].split(" ", 1)[1])
    assert venv.is_absolute() and str(venv).startswith(str(tmp_path)), venv
    _assert_ran_with(proc, calls, venv)
    assert not venv.exists(), "the default temporary venv is removed afterwards"
