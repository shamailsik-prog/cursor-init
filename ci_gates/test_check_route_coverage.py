"""Tests for check_route_coverage.py (Phase 2a G-4): every /api/d1 route must be exercised by a test."""
import pathlib
import subprocess
import sys

SCRIPT = pathlib.Path(__file__).with_name("check_route_coverage.py")

ROUTER = """
const D1_CLIENT = "/api/d1/client"
export const ROUTES = [
  post(`${IDENTITY}/onboardFirm`, onboardFirmOp),
  post(`${D1_CLIENT}/registerClient`, registerClientOp),
  get(`${D1_CLIENT}/getClient`, getClientOp),
  get("/api/d1/matter/listMatters", listMattersOp),
]
"""


def run(tmp_path, router, tests):
    r = tmp_path / "router.ts"
    r.write_text(router)
    d = tmp_path / "test"
    d.mkdir()
    for name, text in tests.items():
        (d / name).write_text(text)
    return subprocess.run([sys.executable, str(SCRIPT), str(r), str(d)], capture_output=True, text=True)


def test_untested_route_fails_and_is_named(tmp_path):
    res = run(tmp_path, ROUTER, {"a.test.ts": 'const x = viaApi("registerClient")\nconst y = viaApi("getClient")\n'})
    assert res.returncode == 1
    assert "listMatters" in res.stdout
    assert "getClient" not in res.stdout.split("MISSING")[-1]


def test_all_covered_via_viaApi_and_path_literal_passes(tmp_path):
    res = run(
        tmp_path,
        ROUTER,
        {
            "a.test.ts": 'viaApi("registerClient"); viaApi<Foo>("getClient")',
            "b.test.ts": 'call("/api/d1/matter/listMatters")',
        },
    )
    assert res.returncode == 0, res.stdout
    assert "3 d1 routes" in res.stdout


def test_non_d1_routes_ignored_and_no_routes_is_an_error(tmp_path):
    assert run(tmp_path, "nothing here", {}).returncode == 1
