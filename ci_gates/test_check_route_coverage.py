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


def run(tmp_path, router, tests, args=()):
    r = tmp_path / "router.ts"
    r.write_text(router)
    d = tmp_path / "test"
    d.mkdir()
    for name, text in tests.items():
        (d / name).write_text(text)
    return subprocess.run([sys.executable, str(SCRIPT), *args, str(r), str(d)], capture_output=True, text=True)


def test_untested_route_fails_and_is_named(tmp_path):
    res = run(tmp_path, ROUTER, {"a.test.ts": 'const x = viaApi("registerClient")\nconst y = viaApi("getClient")\n'})
    assert res.returncode == 1
    assert "listMatters" in res.stdout
    assert "getClient" not in res.stdout.split("MISSING")[-1]


def test_path_literal_alone_does_not_cover(tmp_path):
    res = run(tmp_path, ROUTER, {"a.test.ts": 'viaApi("registerClient"); viaApi("getClient"); const p = ["/api/d1/matter/listMatters"]'})
    assert res.returncode == 1
    assert "listMatters" in res.stdout


def test_extraction_and_table_count_must_agree(tmp_path):
    router = ROUTER + '\n  get(`${D1_UNKNOWN}/ghost`, ghostOp),\n'
    res = run(tmp_path, router, {"a.test.ts": 'viaApi("registerClient"); viaApi("getClient"); viaApi("listMatters")'})
    assert res.returncode == 1
    assert "disagree" in res.stdout


def test_all_covered_via_viaApi_passes(tmp_path):
    res = run(
        tmp_path,
        ROUTER,
        {
            "a.test.ts": 'viaApi("registerClient"); viaApi<Foo>("getClient")',
            "b.test.ts": 'viaApi<Foo>(  "listMatters" )',
        },
    )
    assert res.returncode == 0, res.stdout
    assert "3 d1 routes" in res.stdout


def test_non_d1_routes_ignored_and_no_routes_is_an_error(tmp_path):
    assert run(tmp_path, "nothing here", {}).returncode == 1


ENTITY_ROUTER = """
const D1_ENTITY = "/api/d1/entity"
export const ROUTES = [
  get(`${D1_ENTITY}/listReviewQueue`, listReviewQueueOp),
  get(`${D1_ENTITY}/getEntity`, getEntityOp),
]
"""


def test_entity_prefix_constant_is_resolved_and_uncovered_route_named(tmp_path):
    res = run(tmp_path, ENTITY_ROUTER, {"a.test.ts": 'viaApi("listReviewQueue")'})
    assert res.returncode == 1
    assert "/api/d1/entity/getEntity" in res.stdout
    assert "/api/d1/entity/listReviewQueue" not in res.stdout.split("MISSING")[-1]


COVERED = {
    "a.test.ts": 'viaApi("registerClient"); viaApi("getClient"); viaApi("listMatters")',
}


def test_platform_jobs_domain(tmp_path):
    router = 'const PLATFORM_JOBS = "/api/platform/jobs"\nexport const ROUTES = [\n  get(`${PLATFORM_JOBS}/listJobs`, a),\n  post(`${PLATFORM_JOBS}/cancelJob`, b),\n]\n'
    r = run(tmp_path, router, {"a.test.ts": 'viaApi("listJobs")'}, args=["--domain", "platform/jobs"])
    assert r.returncode == 1
    assert "platform/jobs routes found: 2; platform/jobs entries in the route table: 2" in r.stdout
    assert "/api/platform/jobs/cancelJob" in r.stdout


def test_default_domain_ignores_platform_routes(tmp_path):
    r = run(tmp_path, ROUTER + 'const PLATFORM_JOBS = "/api/platform/jobs"\n  get(`${PLATFORM_JOBS}/getJob`, g),\n', COVERED)
    assert "d1 routes found: 3; d1 entries in the route table: 3" in r.stdout and r.returncode == 0
