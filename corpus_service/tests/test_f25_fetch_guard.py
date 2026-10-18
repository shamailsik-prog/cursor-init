"""Audit F25 closure guard: no corpus code opens an HTTP path of its own (spec R1, R4, R12, R13).

1. An AST scan of every non-test module under corpus_service/ (scraper/, bootstrap_harvest.py,
   migrations/) except scraper/net/fetch_policy.py fails on: building an httpx client or transport
   or an httpcore pool; module-level httpx request functions; HTTP or browser libraries that would
   bypass the boundary; raw sockets; any ``follow_redirects`` other than a literal False; any
   ``_test_*`` keyword (the boundary's test-only hooks). Positive controls prove the scanner sees
   each form, so the guard cannot rot into a pass.
2. Every harvester the dispatcher routes, except PakistanLawSite (import folder, no network), gets
   its client from ``fetch_policy.fetcher_for`` with a registered policy; bootstrap_harvest.py uses
   ``sync_fetcher_for`` for each source it harvests.
3. The allowlists match the source registry: every seeded ``scraper_sources.source_url`` of a routed
   source and every literal URL in a connector passes that connector's policy, and no connector
   carries a plain-http URL. Production policies are hostnames on 443 only.
"""

import ast
import re
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
POLICY_MODULE = Path("scraper") / "net" / "fetch_policy.py"

FORBIDDEN_CALLS = {
    "httpx.Client", "httpx.AsyncClient", "httpx.HTTPTransport", "httpx.AsyncHTTPTransport",
    "httpx.get", "httpx.post", "httpx.put", "httpx.patch", "httpx.delete", "httpx.head", "httpx.options",
    "httpx.request", "httpx.stream",
    "httpcore.ConnectionPool", "httpcore.AsyncConnectionPool", "httpcore.HTTPProxy", "httpcore.AsyncHTTPProxy",
    "httpcore.SOCKSProxy", "httpcore.AsyncSOCKSProxy", "httpcore.HTTPConnection", "httpcore.AsyncHTTPConnection",
    "httpcore.request", "httpcore.stream",
    "socket.socket", "socket.create_connection", "asyncio.open_connection",
}
FORBIDDEN_IMPORTS = (
    "requests", "aiohttp", "urllib.request", "urllib3", "http.client", "httplib2", "pycurl", "playwright",
    "treq", "tornado.httpclient", "websockets",
)
# Harvester modules that fetch nothing (PakistanLawSite: licensed API placeholder + import folder).
NO_NETWORK_HARVESTERS = {"scraper.tasks.pakistanlawsite"}


def _dotted(node, aliases):
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value, aliases)
        return f"{base}.{node.attr}" if base else None
    return None


def _forbidden_import(name):
    return any(name == f or name.startswith(f + ".") for f in FORBIDDEN_IMPORTS)


def scan_source(source, where="<snippet>"):
    """Every way ``source`` opens an HTTP path outside the fetch boundary."""
    tree = ast.parse(source)
    aliases = {}
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
                if _forbidden_import(alias.name):
                    found.append(f"{where}:{node.lineno} imports {alias.name}")
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                full = f"{node.module}.{alias.name}"
                aliases[alias.asname or alias.name] = full
                if _forbidden_import(node.module) or _forbidden_import(full):
                    found.append(f"{where}:{node.lineno} imports {full}")
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        dotted = _dotted(node.func, aliases)
        if dotted in FORBIDDEN_CALLS:
            found.append(f"{where}:{node.lineno} calls {dotted}")
        for kw in node.keywords:
            if kw.arg == "follow_redirects" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                found.append(f"{where}:{node.lineno} passes follow_redirects={ast.unparse(kw.value)}")
            if kw.arg and kw.arg.startswith("_test_"):
                found.append(f"{where}:{node.lineno} passes the test-only hook {kw.arg}")
    return found


def corpus_modules():
    for path in sorted(PROJECT_ROOT.rglob("*.py")):
        rel = path.relative_to(PROJECT_ROOT)
        if rel.parts[0] == "tests" or rel == POLICY_MODULE:
            continue
        yield rel, path


def test_no_corpus_module_opens_its_own_http_path():
    violations = []
    for rel, path in corpus_modules():
        violations += scan_source(path.read_text(encoding="utf-8"), str(rel))
    assert not violations, "outbound HTTP outside scraper/net/fetch_policy.py:\n" + "\n".join(violations)


@pytest.mark.parametrize(
    "snippet",
    [
        "import httpx\nhttpx.AsyncClient()",
        "import httpx as h\nh.Client(timeout=1)",
        "from httpx import AsyncClient\nAsyncClient()",
        "from httpx import AsyncClient as C\nC()",
        "import httpx\nhttpx.AsyncHTTPTransport()",
        "import httpx\nhttpx.get('https://x.invalid')",
        "import httpx\nhttpx.stream('GET', 'https://x.invalid')",
        "import httpcore\nhttpcore.AsyncConnectionPool()",
        "import requests",
        "import requests.adapters",
        "from urllib import request",
        "import urllib.request",
        "from urllib.request import urlopen",
        "import aiohttp",
        "from http.client import HTTPSConnection",
        "import urllib3",
        "from playwright.async_api import async_playwright",
        "import socket\nsocket.create_connection(('h', 1))",
        "import asyncio\nasyncio.open_connection('h', 1)",
        "client.get(url, follow_redirects=True)",
        "client.stream('GET', url, follow_redirects=flag)",
        "fetch_policy.PolicyFetcher(p, _test_loopback_origins={('h', 1)})",
        "PolicyFetcher(p, _test_resolver=r)",
    ],
)
def test_guard_positive_controls(snippet):
    assert scan_source(snippet), snippet


# The independent re-audit's probe (scratchpad reaudit-f25/zz_audit_probe.py), one form per case: the
# guard of PR #65 caught only the control (p18). Each must now fail the guard on its own.
REAUDIT_PROBE_FORMS = {
    "p01 importlib.import_module('requests')": "import importlib\ndef p01(u):\n    return importlib.import_module('requests').get(u)",
    "p02 __import__('urllib.request')": "def p02(u):\n    return __import__('urllib.request').request.urlopen(u)",
    "p03 urllib.request after import urllib.parse": "import urllib.parse\ndef p03(u):\n    return urllib.request.urlopen(u)",
    "p04 subprocess curl": "import subprocess\ndef p04(u):\n    return subprocess.run(['curl', '-s', u])",
    "p05 os.system curl": "import os\ndef p05(u):\n    return os.system('curl -s ' + u)",
    "p06 getattr(httpx, ...)": "import httpx\ndef p06():\n    return getattr(httpx, 'Async' + 'Client')()",
    "p07 subclass httpx.AsyncClient": "import httpx\nclass Sneaky(httpx.AsyncClient):\n    pass\ndef p07():\n    return Sneaky()",
    "p08 httpx._client": "from httpx import _client as hc\ndef p08():\n    return hc.AsyncClient()",
    "p09 loop.create_connection": "import asyncio\nasync def p09(h):\n    return await asyncio.get_running_loop().create_connection(asyncio.Protocol, h, 80)",
    "p10 anyio.connect_tcp": "import anyio\nasync def p10(h):\n    return await anyio.connect_tcp(h, 80)",
    "p11 httpcore backend": "import httpcore\nasync def p11(h):\n    return await httpcore.AnyIOBackend().connect_tcp(h, 80)",
    "p12 FetchPolicy/PolicyFetcher outside the registry": (
        "from scraper.net import fetch_policy\ndef p12():\n"
        "    wide = fetch_policy.FetchPolicy(name='Wide', hosts=frozenset({'169.254.169.254.nip.io'}), ports=frozenset({80, 443}))\n"
        "    return fetch_policy.PolicyFetcher(wide)"
    ),
    "p13 ftplib": "import ftplib\ndef p13(h):\n    return ftplib.FTP(h)",
    "p14 smtplib": "import smtplib\ndef p14(h):\n    return smtplib.SMTP(h)",
    "p15 xmlrpc.client": "import xmlrpc.client\ndef p15(u):\n    return xmlrpc.client.ServerProxy(u).system.listMethods()",
    "p16 ssl.get_server_certificate": "import ssl\ndef p16(h):\n    return ssl.get_server_certificate((h, 443))",
    "p17 httpx.Client attribute": "import httpx\ndef p17(u):\n    return httpx.Client.__call__",
    "p18 control": "import httpx\ndef p18():\n    return httpx.AsyncClient(follow_redirects=True)",
    "p19 httpx._transports": "import httpx\ndef p19():\n    return httpx._transports.default.AsyncHTTPTransport()",
    "p20 os.popen wget": "import os\ndef p20(u):\n    return os.popen('wget -qO- ' + u).read()",
}
MORE_BYPASS_FORMS = {
    "backend loopback hook keyword": "from scraper.net import fetch_policy\nfetch_policy._GuardedBackend('x', loopback_origins={('h', 1)})",
    "loopback_origins keyword alone": "make(loopback_origins={('h', 1)})",
    "private boundary member": "from scraper.net import fetch_policy\nfetch_policy._GuardedTransport",
    "registry mutation": "from scraper.net import fetch_policy\nfetch_policy.SOURCE_POLICIES['Wide'] = None",
    "factory monkeypatch": "from scraper.net import fetch_policy\nfetch_policy.fetcher_for = lambda *a, **k: None",
    "setattr on the boundary": "from scraper.net import fetch_policy\nsetattr(fetch_policy, 'fetcher_for', None)",
    "string-built dynamic import": "import importlib\nimportlib.import_module('req' + 'uests')",
    "dynamic import by variable": "import importlib\nname = 'requests'\nimportlib.import_module(name)",
    "builtins.__import__": "import builtins\nbuiltins.__import__('socket')",
    "vars(httpx)": "import httpx\nvars(httpx)['AsyncClient']()",
    "httpx.__dict__": "import httpx\nhttpx.__dict__['AsyncClient']()",
    "socket import": "import socket",
    "asyncio.open_connection alias": "from asyncio import open_connection\nopen_connection('h', 1)",
    "asyncio subprocess": "import asyncio\nasyncio.create_subprocess_exec('curl', 'http://h')",
    "robots.txt fetch by urllib": "from urllib.robotparser import RobotFileParser\nRobotFileParser('http://h/robots.txt').read()",
    "lxml fetches a URL": "from lxml import etree\netree.parse('http://h/x.xml')",
    "webbrowser": "import webbrowser\nwebbrowser.open('http://h')",
    "ssl wrap_socket": "import ssl\nssl.create_default_context().wrap_socket(s, server_hostname='h')",
}


@pytest.mark.parametrize("snippet", list(REAUDIT_PROBE_FORMS.values()) + list(MORE_BYPASS_FORMS.values()),
                         ids=list(REAUDIT_PROBE_FORMS) + list(MORE_BYPASS_FORMS))
def test_guard_catches_every_reaudit_probe_form(snippet):
    assert scan_source(snippet, "scraper/tasks/zz_probe.py"), snippet


@pytest.mark.parametrize(
    "snippet, where",
    [
        ("import importlib\nharvest = getattr(importlib.import_module(module_name), function_name)", "scraper/tasks/dispatcher.py"),
        ("import ssl\nctx = ssl.create_default_context(cafile=path)", "scraper/config.py"),
        ("import asyncio\nasyncio.run(main())\nasyncio.sleep(1)", "scraper/tasks/x.py"),
        ("import os\nos.getenv('X')\nos.environ.get('Y')\nos.replace(a, b)", "scraper/tasks/x.py"),
        ("from urllib.robotparser import RobotFileParser\nrp = RobotFileParser()\nrp.parse(lines)", "bootstrap_harvest.py"),
        ("x = getattr(settings, 'CORS_ALLOW_ORIGINS', '')", "scraper/main.py"),
        ("from scraper.net import fetch_policy\ndef f(c: fetch_policy.PolicyFetcher) -> fetch_policy.FetchedResponse: ...", "scraper/tasks/x.py"),
        ("from scraper.net import fetch_policy\ntry:\n    pass\nexcept fetch_policy.FetchRefused:\n    raise", "scraper/tasks/x.py"),
        ("from scraper.net import fetch_policy\np = fetch_policy.SOURCE_POLICIES['NasirLawSite']\nq = fetch_policy.policy_for('X')", "scraper/tasks/x.py"),
        ("from scraper.net import fetch_policy\nwith fetch_policy.sync_fetcher_for('PakistanCode', headers=h) as c:\n    c.get(u)", "bootstrap_harvest.py"),
    ],
)
def test_guard_round_two_negative_controls(snippet, where):
    assert scan_source(snippet, where) == [], (where, snippet)


def test_source_policies_are_read_only():
    from scraper.net import fetch_policy

    with pytest.raises(TypeError):
        fetch_policy.SOURCE_POLICIES["Wide"] = fetch_policy.policy_for("NasirLawSite")


@pytest.mark.parametrize(
    "snippet",
    [
        "from scraper.net import fetch_policy\nasync def f(u):\n    async with fetch_policy.fetcher_for('NasirLawSite') as c:\n        await c.get(u)",
        "client.get(url, follow_redirects=False)",
        "import httpx\ndef f(client: httpx.AsyncClient) -> httpx.Response: ...",
        "import httpx\ntry:\n    pass\nexcept httpx.RequestError:\n    pass",
        "from urllib.parse import urljoin\nurljoin('a', 'b')",
    ],
)
def test_guard_negative_controls(snippet):
    assert scan_source(snippet) == [], snippet


# ---------------------------------------------------------------------------------------------
# Adoption and registry
# ---------------------------------------------------------------------------------------------
def _module_path(module):
    return PROJECT_ROOT.joinpath(*module.split(".")).with_suffix(".py")


def _factory_policies(path, factory):
    """String policy names passed to ``fetch_policy.<factory>(...)`` in a module."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == factory
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "fetch_policy"
        ):
            assert node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str), (
                f"{path.name}:{node.lineno}: {factory} must name its policy with a string literal"
            )
            names.append(node.args[0].value)
    return names


def _route_policies():
    from scraper.tasks.dispatcher import ROUTES

    by_module = {}
    for source_name, (module, _function, _kind) in ROUTES.items():
        if module in NO_NETWORK_HARVESTERS:
            continue
        names = set(_factory_policies(_module_path(module), "fetcher_for"))
        by_module.setdefault(module, (names, []))[1].append(source_name)
    return by_module


def test_every_fetching_harvester_uses_one_registered_policy():
    from scraper.net.fetch_policy import SOURCE_POLICIES

    problems = {}
    for module, (names, sources) in _route_policies().items():
        if len(names) != 1 or not names <= set(SOURCE_POLICIES):
            problems[module] = {"policies": sorted(names), "sources": sources}
    assert not problems, problems
    boot = set(_factory_policies(PROJECT_ROOT / "bootstrap_harvest.py", "sync_fetcher_for"))
    assert boot == {"PakistanCode", "NasirLawSite", "NationalAssembly"}, boot


def _seeded_source_urls():
    """source_name -> source_url from scraper/database.py's seed list (dict(source_name=..., ...))."""
    tree = ast.parse((PROJECT_ROOT / "scraper" / "database.py").read_text(encoding="utf-8"))
    seeds = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
            kw = {k.arg: k.value.value for k in node.keywords if isinstance(k.value, ast.Constant)}
            if "source_name" in kw and "source_url" in kw:
                seeds[kw["source_name"]] = kw["source_url"]
    return seeds


def _literal_urls(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and re.match(r"(?i)https?://", node.value)
    ]


def test_allowlists_cover_the_source_registry_and_every_connector_url():
    from scraper.net.fetch_policy import policy_for

    seeds = _seeded_source_urls()
    problems = []
    for module, (names, sources) in _route_policies().items():
        policy = policy_for(next(iter(names)))
        for source_name in sources:
            if not policy.allows(seeds[source_name]):
                problems.append(f"{source_name}: seeded {seeds[source_name]} refused by {policy.name}")
        for url in _literal_urls(_module_path(module)):
            if not policy.allows(url):
                problems.append(f"{module}: literal {url} refused by {policy.name}")
    boot_policies = [policy_for(n) for n in ("PakistanCode", "NasirLawSite", "NationalAssembly")]
    for url in _literal_urls(PROJECT_ROOT / "bootstrap_harvest.py"):
        if not any(p.allows(url) for p in boot_policies):
            problems.append(f"bootstrap_harvest.py: literal {url} refused by every policy")
    assert not problems, "\n".join(problems)


def test_production_policies_are_hostnames_on_443_only():
    import ipaddress

    from scraper.net.fetch_policy import SOURCE_POLICIES

    ldh = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
    for name, policy in SOURCE_POLICIES.items():
        assert policy.name == name
        assert policy.ports == frozenset({443}), name
        assert policy.hosts, name
        for host in policy.hosts | {s[1:] for s in policy.host_suffixes}:
            assert ldh.match(host) and "xn--" not in host, (name, host)
            with pytest.raises(ValueError):
                ipaddress.ip_address(host)
        assert all(s.startswith(".") for s in policy.host_suffixes), name
