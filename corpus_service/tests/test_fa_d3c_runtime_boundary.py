"""FA-D3C-001 and FA-D3C-002 guard: the corpus runtime installs no headless browser, and holds no
provider SDK, provider key or provider host (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-
boundary-design.md, rulings R1-R3 and R15-R16).

Layer 18 W-6 and L17.12: while ``corpus_service/`` sits in the application repository, the Layer 18
scraper guard applies to it with no exemption, and a paid model call goes through P1, never straight to a
provider. G-0 [2] and [3] hold the full tree to Playwright/Puppeteer and the provider SDK list; this file
holds the corpus to a wider headless-browser list and to the corpus-only surfaces those guards do not read
(``Settings`` fields, provider host literals, the F25 registry, the compose and env files).

Run by the existing ``corpus-service`` CI job (``python -m pytest corpus_service/tests``). Standard library
plus the corpus's own modules; no network.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Iterator, List, Tuple

import pytest

from import_contract import parse_requirements

PROJECT_ROOT = Path(__file__).resolve().parents[1]
# Every Python file the image copies and runs (the F31 runtime roots).
RUNTIME_ROOTS = ("scraper", "migrations", "bootstrap_harvest.py")

# ---------------------------------------------------------------------------------------------
# FA-D3C-001: headless browsers
# ---------------------------------------------------------------------------------------------
# PyPI distributions (PEP 503-normalised) that drive or ship a headless browser.
BROWSER_DISTRIBUTIONS = frozenset({
    "playwright", "pytest-playwright", "playwright-stealth", "pyppeteer", "pyppeteer2", "selenium",
    "seleniumbase", "selenium-wire", "undetected-chromedriver", "splinter", "helium", "requests-html",
    "nodriver", "zendriver", "camoufox", "botasaurus", "browser-use", "chromedriver-autoinstaller",
    "webdriver-manager", "pychrome", "arsenic",
})
# Top-level Python modules of the same.
BROWSER_MODULES = (
    "playwright", "playwright_stealth", "pyppeteer", "selenium", "seleniumbase", "seleniumwire",
    "undetected_chromedriver", "splinter", "helium", "requests_html", "nodriver", "zendriver",
    "camoufox", "botasaurus", "browser_use", "chromedriver_autoinstaller", "webdriver_manager",
    "pychrome", "arsenic",
)
# A browser install in a Dockerfile or shell line: `playwright install`, `python -m playwright install`,
# or a browser / driver package from apt, apk, dnf or a download.
BROWSER_INSTALL = re.compile(
    r"\bplaywright(?:-core)?(?:@[\w.^~-]+)?\s+install(?:-deps)?\b"
    r"|\b(?:chromium(?:-browser|-driver|-headless-shell|-shell)?|google-chrome(?:-stable|-beta|-unstable)?"
    r"|firefox(?:-esr)?|chromedriver|geckodriver|msedgedriver|phantomjs)\b",
    re.I,
)
# A Settings field for a browser.
BROWSER_SETTING = re.compile(r"PLAYWRIGHT|PUPPETEER|PYPPETEER|SELENIUM|CHROMIUM|CHROME|HEADLESS|BROWSER", re.I)

# ---------------------------------------------------------------------------------------------
# FA-D3C-002: provider SDKs, keys and hosts
# ---------------------------------------------------------------------------------------------
PROVIDER_DISTRIBUTIONS = frozenset({
    "openai", "anthropic", "groq", "cohere", "mistralai", "voyageai", "google-generativeai", "google-genai",
    "google-cloud-aiplatform", "vertexai", "together", "litellm", "langchain-openai", "langchain-anthropic",
    "langchain-google-genai", "llama-index-llms-openai", "llama-index-embeddings-openai", "replicate",
    "huggingface-hub", "elevenlabs", "deepl", "openai-whisper", "sentence-transformers", "fireworks-ai",
})
PROVIDER_MODULES = (
    "openai", "anthropic", "groq", "cohere", "mistralai", "voyageai", "google.generativeai", "google.genai",
    "google.cloud.aiplatform", "vertexai", "together", "litellm", "langchain_openai", "langchain_anthropic",
    "langchain_google_genai", "llama_index.llms.openai", "llama_index.embeddings.openai", "replicate",
    "huggingface_hub", "elevenlabs", "deepl", "whisper", "sentence_transformers", "fireworks",
)
# The env names a provider key travels under (F18's list, PROVIDER_KEY_ENV_NAMES, plus the embedding
# providers) and any other *_API_KEY whose prefix names a provider.
PROVIDER_KEY_NAME = re.compile(
    r"\b(?:AZURE_)?(?:OPENAI|ANTHROPIC|CLAUDE|GROQ|COHERE|CO|MISTRAL|VOYAGE|GEMINI|GOOGLE_GENERATIVE_AI|GOOGLE_AI"
    r"|VERTEX|TOGETHER|PERPLEXITY|PPLX|DEEPSEEK|FIREWORKS|REPLICATE|HUGGINGFACE|HF|ELEVENLABS|DEEPL|XAI"
    r"|AI_GATEWAY|VERCEL_AI_GATEWAY|OPENROUTER)_(?:API_)?(?:KEY|TOKEN)\b"
)
PROVIDER_HOSTS = (
    "api.openai.com", "openai.azure.com", "api.anthropic.com", "generativelanguage.googleapis.com",
    "aiplatform.googleapis.com", "api.groq.com", "api.cohere.ai", "api.cohere.com", "api.mistral.ai",
    "api.voyageai.com", "api.together.xyz", "api.together.ai", "api.perplexity.ai", "api.deepseek.com",
    "api.fireworks.ai", "api.replicate.com", "api-inference.huggingface.co", "api.elevenlabs.io",
    "api.deepl.com", "api-free.deepl.com", "ai-gateway.vercel.sh", "openrouter.ai", "api.x.ai",
)
# Deploy surfaces of the corpus image and its compose deployment: none may name a provider key.
DEPLOY_SURFACES = ("docker-compose.yml", "app.env", ".env.example", "Dockerfile", "tests/e2e/compose.e2e.yml",
                   "tests/e2e/Dockerfile")


# ---------------------------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------------------------
def runtime_files() -> Iterator[Path]:
    for root in RUNTIME_ROOTS:
        path = PROJECT_ROOT / root
        if path.is_file():
            yield path
        else:
            yield from sorted(p for p in path.rglob("*.py") if "__pycache__" not in p.parts)


def requirement_files() -> List[Path]:
    # Audit F46: pip-compile sources (*.in) may use -r includes; guards scan install manifests (*.txt) only.
    found = sorted(
        p for p in PROJECT_ROOT.rglob("*")
        if p.is_file() and re.fullmatch(r"(?:[\w.-]+[-_.])?requirements(?:[-_.][\w.-]+)?\.txt", p.name, re.I)
        and "__pycache__" not in p.parts
    )
    assert found, "no requirements file found under corpus_service/ (the guard would pass vacuously)"
    return found


def dockerfiles() -> List[Path]:
    found = sorted(
        p for p in PROJECT_ROOT.rglob("*")
        if p.is_file() and re.fullmatch(r"(?:docker|container)file(?:[.-][\w.-]+)?|[\w.-]+\.(?:docker|container)file", p.name, re.I)
        and not p.name.endswith(".dockerignore")
    )
    assert found, "no Dockerfile found under corpus_service/ (the guard would pass vacuously)"
    return found


def instruction_lines(text: str) -> str:
    """A Dockerfile's instructions with comments dropped and continuations joined."""
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return re.sub(r"\\\s*\n", " ", "\n".join(lines))


def imported_modules(tree: ast.AST) -> Iterator[Tuple[int, str]]:
    """Every absolute module an AST imports, by statement or by a literal importlib/__import__ call."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.lineno, node.module
            for alias in node.names:
                yield node.lineno, f"{node.module}.{alias.name}"
        elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
            if name in {"import_module", "__import__"}:
                yield node.lineno, node.args[0].value


def under(module: str, roots) -> bool:
    return any(module == r or module.startswith(r + ".") for r in roots)


def string_constants(tree: ast.AST) -> Iterator[Tuple[int, str]]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node.lineno, node.value


def parsed_runtime() -> Iterator[Tuple[str, ast.AST]]:
    for path in runtime_files():
        yield path.relative_to(PROJECT_ROOT).as_posix(), ast.parse(path.read_text(encoding="utf-8"), str(path))


def settings_fields() -> List[str]:
    from scraper.config import Settings

    fields = list(Settings.model_fields)
    assert len(fields) > 20, "Settings has suspiciously few fields (the guard would pass vacuously)"
    return fields


# ---------------------------------------------------------------------------------------------
# FA-D3C-001
# ---------------------------------------------------------------------------------------------
def test_no_requirements_file_installs_a_headless_browser():
    found = []
    for path in requirement_files():
        rel = path.relative_to(PROJECT_ROOT).as_posix()
        for name in sorted(parse_requirements(path.read_text(encoding="utf-8"), rel) & BROWSER_DISTRIBUTIONS):
            found.append(f"{rel}: {name}")
    assert found == [], f"FA-D3C-001: a headless browser in a corpus requirements file: {found}"


def test_no_dockerfile_installs_a_browser():
    found = []
    for path in dockerfiles():
        rel = path.relative_to(PROJECT_ROOT).as_posix()
        for match in BROWSER_INSTALL.finditer(instruction_lines(path.read_text(encoding="utf-8"))):
            found.append(f"{rel}: {match.group(0)}")
    assert found == [], f"FA-D3C-001: a browser install in a corpus Dockerfile: {found}"


def test_no_runtime_module_imports_a_browser():
    found = [
        f"{rel}:{line}: {module}"
        for rel, tree in parsed_runtime()
        for line, module in imported_modules(tree)
        if under(module, BROWSER_MODULES)
    ]
    assert found == [], f"FA-D3C-001: a runtime module imports a browser driver: {found}"


def test_settings_carry_no_browser_switch():
    found = [name for name in settings_fields() if BROWSER_SETTING.search(name)]
    assert found == [], f"FA-D3C-001: browser settings in scraper.config.Settings (dead, R1): {found}"


def test_failover_names_no_browser_exception():
    """R1: `PlaywrightTimeoutError` in the Seat B failover names a class no installed package defines."""
    source = (PROJECT_ROOT / "scraper" / "config.py").read_text(encoding="utf-8")
    assert "PlaywrightTimeoutError" not in source


# ---------------------------------------------------------------------------------------------
# FA-D3C-002
# ---------------------------------------------------------------------------------------------
def test_no_requirements_file_installs_a_provider_sdk():
    found = []
    for path in requirement_files():
        rel = path.relative_to(PROJECT_ROOT).as_posix()
        for name in sorted(parse_requirements(path.read_text(encoding="utf-8"), rel) & PROVIDER_DISTRIBUTIONS):
            found.append(f"{rel}: {name}")
    assert found == [], f"FA-D3C-002: a provider SDK in a corpus requirements file: {found}"


def test_no_runtime_module_imports_a_provider_sdk():
    found = [
        f"{rel}:{line}: {module}"
        for rel, tree in parsed_runtime()
        for line, module in imported_modules(tree)
        if under(module, PROVIDER_MODULES)
    ]
    assert found == [], f"FA-D3C-002: a runtime module imports a provider SDK (P1 is the only path): {found}"


def test_no_runtime_module_names_a_provider_host():
    found = [
        f"{rel}:{line}: {host}"
        for rel, tree in parsed_runtime()
        for line, value in string_constants(tree)
        for host in PROVIDER_HOSTS
        if host in value.lower()
    ]
    assert found == [], f"FA-D3C-002: a provider API host in corpus runtime source: {found}"


def test_settings_carry_no_provider_key():
    found = [name for name in settings_fields() if PROVIDER_KEY_NAME.search(name)]
    assert found == [], f"FA-D3C-002: a provider key setting in scraper.config.Settings: {found}"


@pytest.mark.parametrize("rel", DEPLOY_SURFACES)
def test_deploy_surface_hands_no_provider_key(rel):
    path = PROJECT_ROOT / rel
    assert path.is_file(), f"{rel} is gone: update DEPLOY_SURFACES"
    found = [
        f"{rel}:{n}: {m.group(0)}"
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        for m in PROVIDER_KEY_NAME.finditer(line)
    ]
    assert found == [], f"FA-D3C-002: a corpus deploy surface names a provider key: {found}"


def test_no_registered_fetch_policy_admits_a_provider_host():
    """F25's registry is the only way out of the corpus; no source policy may reach a provider."""
    from scraper.net import fetch_policy

    found = [
        f"{name}: {host}"
        for name, policy in fetch_policy.SOURCE_POLICIES.items()
        for host in PROVIDER_HOSTS
        if policy.host_allowed(host)
    ]
    assert found == [], f"FA-D3C-002: an F25 source policy admits a provider host: {found}"


# ---------------------------------------------------------------------------------------------
# Positive controls: each reader sees the form it guards against, so the guard cannot rot into a pass.
# ---------------------------------------------------------------------------------------------
def test_readers_see_what_they_guard():
    assert {"playwright", "selenium"} <= parse_requirements("playwright>=1\nSelenium[x]==4 ; python_version>'3'\n")
    assert BROWSER_INSTALL.search(instruction_lines("RUN pip install x \\\n && playwright install chromium --with-deps\n"))
    assert BROWSER_INSTALL.search(instruction_lines("RUN apt-get install -y chromium-driver\n"))
    assert not BROWSER_INSTALL.search(instruction_lines("# playwright install chromium\nRUN true\n"))
    tree = ast.parse("import importlib\nfrom openai import AsyncOpenAI\nimportlib.import_module('playwright.async_api')\n")
    modules = [m for _, m in imported_modules(tree)]
    assert any(under(m, PROVIDER_MODULES) for m in modules)
    assert any(under(m, BROWSER_MODULES) for m in modules)
    assert PROVIDER_KEY_NAME.search("OPENAI_API_KEY: ${OPENAI_API_KEY:-}")
    assert PROVIDER_KEY_NAME.search("AI_GATEWAY_API_KEY=x")
    assert not PROVIDER_KEY_NAME.search("ADMIN_API_KEY=x\nENCRYPTION_KEY=x\nP1_EMBEDDING_URL=x")
    assert BROWSER_SETTING.search("PLAYWRIGHT_ENABLED")
