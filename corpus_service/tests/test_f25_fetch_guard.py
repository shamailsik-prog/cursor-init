"""Audit F25 closure guard: no corpus code opens an HTTP path of its own (spec R1, R4, R12, R13).

1. An AST scan of every non-test module under corpus_service/ (scraper/, bootstrap_harvest.py,
   migrations/) except scraper/net/fetch_policy.py fails on: importing or referencing a network,
   socket, process or browser module (by any alias, even after only ``import urllib.parse``);
   httpx client/transport classes and request functions outside type annotations (calls, aliases,
   subclasses); private members of httpx or the boundary; raw connection methods on any receiver
   (``loop.create_connection``, ``anyio.connect_tcp``); ``os.system`` / ``os.popen`` / exec /
   spawn; ``getattr``/``setattr``/``vars`` on those modules; dynamic imports of them by literal
   (constant-folded) name, and by any computed name outside the dispatcher; building
   ``FetchPolicy`` / ``PolicyFetcher`` outside the registry or writing to the boundary; any
   ``follow_redirects`` other than a literal False; the test-only hooks (``_test_*``,
   ``loopback_origins``). Positive controls (including every form of the re-audit's probe) prove
   the scanner sees each form, so the guard cannot rot into a pass.
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

BOUNDARY = "scraper.net.fetch_policy"
# Modules (and their submodules) that open network paths of their own: nothing outside the boundary
# imports or references them (re-audit round, R21).
FORBIDDEN_MODULES = (
    "requests", "aiohttp", "urllib.request", "urllib3", "http.client", "httplib2", "pycurl", "playwright",
    "treq", "tornado.httpclient", "tornado.simple_httpclient", "tornado.tcpclient", "websockets", "websocket",
    "httpcore", "anyio", "h11", "h2", "trio", "socket", "ftplib", "smtplib", "poplib", "imaplib", "nntplib",
    "telnetlib", "xmlrpc", "webbrowser", "subprocess", "pty", "asyncssh", "paramiko", "pexpect", "curl_cffi",
    "pyppeteer", "selenium", "mechanize", "scrapy", "grpc",
)
# Names inside otherwise-allowed modules that open a network path, run a program, or widen the boundary.
FORBIDDEN_NAMES = (
    "httpx.Client", "httpx.AsyncClient", "httpx.HTTPTransport", "httpx.AsyncHTTPTransport",
    "httpx.get", "httpx.post", "httpx.put", "httpx.patch", "httpx.delete", "httpx.head", "httpx.options",
    "httpx.request", "httpx.stream",
    "asyncio.open_connection", "asyncio.open_unix_connection", "asyncio.create_subprocess_exec",
    "asyncio.create_subprocess_shell",
    "os.system", "os.popen", "os.posix_spawn", "os.posix_spawnp", "os.startfile",
    "ssl.get_server_certificate", "ssl.wrap_socket", "ssl.SSLSocket",
    "lxml.etree.parse", "lxml.etree.iterparse", "lxml.html.parse",
    f"{BOUNDARY}.FetchPolicy", f"{BOUNDARY}.PolicyFetcher",
)
FORBIDDEN_PREFIXES = ("os.exec", "os.spawn")
# Modules whose private members (``_x``, ``__dict__``) nothing outside may reach.
PRIVATE_GUARDED = ("httpx", BOUNDARY)
# Calls of these methods open connections whatever the receiver is (loop.create_connection, ...).
NETWORK_METHODS = {
    "create_connection", "create_unix_connection", "create_datagram_endpoint", "sock_connect", "connect_tcp",
    "connect_unix", "connect_unix_socket", "open_connection", "open_unix_connection", "wrap_socket", "wrap_bio",
    "urlopen", "urlretrieve", "build_opener", "set_url",
}
# Roots that getattr/setattr/delattr/vars and writes may not touch.
NETWORK_ROOTS = (
    "httpx", "httpcore", "anyio", "socket", "ssl", "asyncio", "urllib", "http", "subprocess", "os", "importlib",
    "builtins", "sys", "ftplib", "smtplib", "poplib", "imaplib", "nntplib", "telnetlib", "xmlrpc", "requests",
    "aiohttp", "urllib3", "lxml", "webbrowser", "pty", BOUNDARY,
)
DYNAMIC_IMPORTS = {"importlib.import_module", "importlib.__import__", "builtins.__import__", "__import__"}
# The one reviewed dynamic import by variable: the dispatcher's ROUTES (every routed module is
# checked by test_every_fetching_harvester_uses_one_registered_policy).
DYNAMIC_IMPORT_ALLOWLIST = {"scraper/tasks/dispatcher.py"}
FORBIDDEN_KEYWORDS = {"loopback_origins"}
FORBIDDEN_IMPORTS = FORBIDDEN_MODULES  # kept for readers of PR #65's guard
# Harvester modules that fetch nothing (PakistanLawSite: licensed API placeholder + import folder).
NO_NETWORK_HARVESTERS = {"scraper.tasks.pakistanlawsite"}


def _dotted(node, aliases):
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value, aliases)
        return f"{base}.{node.attr}" if base else None
    return None


def _under(name, roots):
    return any(name == r or name.startswith(r + ".") for r in roots)


def _forbidden(name):
    """Why ``name`` (a dotted reference) is outside the boundary, or None."""
    if not name:
        return None
    if _under(name, FORBIDDEN_MODULES):
        return "reaches a network module"
    if _under(name, FORBIDDEN_NAMES) or name.startswith(FORBIDDEN_PREFIXES):
        return "reaches a raw network or process API"
    for root in PRIVATE_GUARDED:
        if name.startswith(root + "."):
            if name[len(root) + 1:].split(".")[0].startswith("_"):
                return "reaches a private member"
    return None


def _const_str(node):
    """A string the AST spells out (literals, + concatenation, f-strings of literals), or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _const_str(node.left), _const_str(node.right)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr):
        parts = [_const_str(v) for v in node.values]
        return None if any(p is None for p in parts) else "".join(parts)
    return None


def _annotation_nodes(tree):
    """ids of every node inside a type annotation (references there open nothing)."""
    ids = set()
    roots = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg]:
                if arg is not None and arg.annotation is not None:
                    roots.append(arg.annotation)
            if node.returns is not None:
                roots.append(node.returns)
        elif isinstance(node, ast.AnnAssign):
            roots.append(node.annotation)
    for root in roots:
        ids.update(id(n) for n in ast.walk(root))
    return ids


def scan_source(source, where="<snippet>"):
    """Every way ``source`` opens a network path outside the fetch boundary, widens the boundary, or
    passes one of its test hooks."""
    tree = ast.parse(source)
    aliases = {}
    found = []

    def flag(node, message):
        found.append(f"{where}:{getattr(node, 'lineno', 0)} {message}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
                why = _forbidden(alias.name)
                if why:
                    flag(node, f"imports {alias.name} ({why})")
        elif isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                full = f"{node.module}.{alias.name}"
                aliases[alias.asname or alias.name] = full
                why = _forbidden(node.module) or _forbidden(full)
                if why:
                    flag(node, f"imports {full} ({why})")

    in_annotation = _annotation_nodes(tree)
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node

    for node in ast.walk(tree):
        # References: the longest dotted chain at each spot, outside annotations.
        if isinstance(node, (ast.Name, ast.Attribute)) and id(node) not in in_annotation:
            parent = parents.get(id(node))
            if not (isinstance(parent, ast.Attribute) and parent.value is node):
                dotted = _dotted(node, aliases)
                why = _forbidden(dotted)
                if why:
                    flag(node, f"references {dotted} ({why})")
        # Writes to the boundary or a network module (monkeypatching a factory, widening the registry).
        if isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, (ast.Store, ast.Del)):
            target = _dotted(node if isinstance(node, ast.Attribute) else node.value, aliases)
            if target and _under(target, NETWORK_ROOTS):
                flag(node, f"modifies {target}")
        if not isinstance(node, ast.Call):
            continue
        dotted = _dotted(node.func, aliases)
        if dotted in DYNAMIC_IMPORTS:
            name = _const_str(node.args[0]) if node.args else None
            if name is None:
                if where not in DYNAMIC_IMPORT_ALLOWLIST:
                    flag(node, f"imports a module by a computed name via {dotted}")
            elif _forbidden(name) or _under(name, NETWORK_ROOTS):
                flag(node, f"imports {name} via {dotted}")
        if dotted in {"getattr", "setattr", "delattr", "vars", "hasattr"} and node.args:
            target = _dotted(node.args[0], aliases)
            if target and _under(target, NETWORK_ROOTS):
                flag(node, f"calls {dotted} on {target}")
        if dotted == "urllib.robotparser.RobotFileParser" and (node.args or node.keywords):
            flag(node, "gives RobotFileParser a URL (it fetches with urllib)")
        if isinstance(node.func, ast.Attribute) and node.func.attr in NETWORK_METHODS:
            flag(node, f"calls .{node.func.attr}() (a raw connection)")
        for kw in node.keywords:
            if kw.arg == "follow_redirects" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                flag(node, f"passes follow_redirects={ast.unparse(kw.value)}")
            if kw.arg and (kw.arg.startswith("_test_") or kw.arg in FORBIDDEN_KEYWORDS):
                flag(node, f"passes the test-only hook {kw.arg}")
    return list(dict.fromkeys(found))


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
    # Code an AST scan cannot read: banned outright (no corpus module uses them).
    "exec of a string": "exec('import socket')",
    "eval of a string": "eval(\"__import__('socket')\")",
    "compile": "code = compile(src, 'probe', 'exec')",
    "ctypes": "import ctypes\nctypes.CDLL(None)",
    "cffi": "from cffi import FFI",
    "sys.modules lookup": "import sys\nsys.modules['socket']",
    "__builtins__": "__builtins__['__import__']('socket')",
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
        ("import re\npattern = re.compile(r'x')\nimport sys\nsys.path.insert(0, p)", "scraper/x.py"),
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
