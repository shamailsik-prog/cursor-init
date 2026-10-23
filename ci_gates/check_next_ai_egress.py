#!/usr/bin/env python3
"""next-ai-egress guard (audit F18; G-0 check [19]).

No paid AI call may leave the Next or eve runtime except through the Cloud Functions P1 control plane
(`/api/platform/brain/committeeBrain`: kill switches, budget, cost log). Spec:
docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md, ruling R9.

Scope of (a)-(d): every file the G-0 walker scans (g0_guard_common.iter_scan_files: tests/, ci_gates/, generated
trees and the eve cache are skipped), except
  - functions/       the control plane itself (which code there may hold a provider SDK is G-0 [3]'s rule), and
  - corpus_service/  the embedding worker (the F27 lane; FA-D3C-002 is allowlisted under G-0 [3]).
Rule (e) uses the same walker and exempts only functions/.

It fails on any of:
  (a) JS/TS importing the `ai` SDK, any `@ai-sdk/*` package other than `@ai-sdk/provider` (types and error classes, no
      network code), or a provider SDK (G-0 [3]'s list plus EXTRA_SDK_PACKAGES): import, export-from, import(),
      require(), type-only imports included;
  (b) JS/TS naming a provider key variable (PROVIDER_KEY_ENV_NAMES), except platform/p1/providerKeyGuard.ts, the runtime
      guard that refuses them;
  (c) JS/TS naming a provider API host (PROVIDER_HOSTS);
  (d) a deploy surface binding a provider key: `.env`, `.env.*` and `*.env` files (an assignment, commented templates
      included); App Hosting, compose, Cloud Build, App Engine and Render YAML, vercel.json, firebase.json, fly.toml,
      netlify.toml and Dockerfiles (any non-comment line naming a key); and a GitHub workflow job that builds, starts or
      deploys the Next/eve service (SERVES_NEXT_RE), or the workflow-level env above such a job (spec R9a). Workflow jobs
      that do not serve that runtime (the Functions suites, the coding-agent workflows) are CI tooling and out of scope;
  (e) any JS/TS file outside functions/ (corpus_service/ included; the G-0 walker still skips root tests/) importing a
      Functions P1 transport or provider module (FUNCTIONS_P1_PAID_MODULES: functions/src/p1/transport and
      functions/src/p1/gateway). The specifier may be the `@/` alias, a relative path, a bare `functions/...` path, an
      extension or `/index`, with a query or hash stripped. Forms: import, export-from, import(), require(),
      require.resolve(), createRequire, and vitest/jest importActual, requireActual, importMock and requireMock.
      A block or line comment may sit between those loader tokens, the same gap the import parser allows (FA-F18-009).
      functions/ itself may import these modules. A module that only shares the name as a prefix
      (`functions/src/p1/transportation`) is not one of them.

There is no allowlist. `--print-key-names` prints PROVIDER_KEY_ENV_NAMES as JSON (tests/f18-next-ai-egress-gate.test.ts
holds it equal to the runtime guard's list).
"""
from __future__ import annotations

import json
import pathlib
import posixpath
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from check_provider_imports import SDK_PACKAGE_SET  # noqa: E402
from g0_guard_common import (  # noqa: E402
    DOCKERFILE_NAME_RE,
    file_kind,
    iter_scan_files,
    JS_WS,
    js_imported_packages,
    js_module_specifiers,
    read_text,
    rel_posix,
)

# Rules (a)-(d) skip functions/ and corpus_service/. Rule (e) skips only functions/.
FUNCTIONS_PREFIX = "functions/"
KEY_GUARD_FILE = "platform/p1/providerKeyGuard.ts"

# Paid transport and the provider caller. Importing either from outside functions/ loads a path that builds a Gateway
# client (activeTransport / callP1). Other functions/src/p1 modules (costTable, types, the HTTP router) are not this path.
FUNCTIONS_P1_PAID_MODULES = (
    "functions/src/p1/transport",
    "functions/src/p1/gateway",
)
_JS_EXT_RE = re.compile(r"\.(?:[cm]?[jt]sx?)$", re.I)
# Same comment-aware gap as g0_guard_common.JS_WS (FA-F18-009). DOTALL so a block comment may contain a newline.
_TEST_LOADER_RE = re.compile(
    rf"""\b(?:vi|jest){JS_WS}\.{JS_WS}(?:importActual|requireActual|importMock|requireMock){JS_WS}(?:<[^<>()]*>)?{JS_WS}\({JS_WS}(["'`])([^"'`\r\n]+)\1""",
    re.DOTALL,
)

# Keep equal to PROVIDER_KEY_ENV_NAMES in platform/p1/providerKeyGuard.ts.
PROVIDER_KEY_ENV_NAMES = (
    "AI_GATEWAY_API_KEY",
    "VERCEL_AI_GATEWAY_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "COHERE_API_KEY",
    "TOGETHER_AI_API_KEY",
    "TOGETHER_API_KEY",
    "PERPLEXITY_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "FIREWORKS_API_KEY",
    "OPENROUTER_API_KEY",
    "REPLICATE_API_TOKEN",
    "ELEVENLABS_API_KEY",
    "DEEPL_AUTH_KEY",
)

# Provider SDKs beyond G-0 [3]'s list (npm package names, matched on the package a specifier resolves to).
EXTRA_SDK_PACKAGES = frozenset(
    {
        "@mistralai/mistralai",
        "cohere-ai",
        "@openrouter/ai-sdk-provider",
        "replicate",
        "@huggingface/inference",
        "@aws-sdk/client-bedrock-runtime",
        "@azure/openai",
        "@google-cloud/aiplatform",
        "@google-cloud/vertexai",
        "@google-cloud/text-to-speech",
        "@fal-ai/client",
        "@elevenlabs/elevenlabs-js",
        "@deepgram/sdk",
        "assemblyai",
    }
)

# Types and error classes only: no network code (checked: its dist has no fetch).
ALLOWED_AI_SDK_PACKAGES = frozenset({"@ai-sdk/provider"})

PROVIDER_HOSTS = (
    "ai-gateway.vercel.sh",
    "api.openai.com",
    "openai.azure.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "aiplatform.googleapis.com",
    "vision.googleapis.com",
    "translation.googleapis.com",
    "speech.googleapis.com",
    "texttospeech.googleapis.com",
    "api.groq.com",
    "api.mistral.ai",
    "api.cohere.ai",
    "api.cohere.com",
    "api.together.xyz",
    "api.together.ai",
    "api.perplexity.ai",
    "api.x.ai",
    "api.deepseek.com",
    "api.fireworks.ai",
    "openrouter.ai",
    "api.replicate.com",
    "api.elevenlabs.io",
    "api.deepl.com",
    "api-free.deepl.com",
)

KEY_RE = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(PROVIDER_KEY_ENV_NAMES) + r")(?![A-Za-z0-9_])")
HOST_RE = re.compile(
    r"(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]+\.)*(" + "|".join(re.escape(h) for h in PROVIDER_HOSTS) + r")(?![A-Za-z0-9-])",
    re.I,
)
ENV_ASSIGN_RE = re.compile(r"^\s*#?\s*(?:export\s+)?(" + "|".join(PROVIDER_KEY_ENV_NAMES) + r")\s*=")

YAML_DEPLOY_RE = re.compile(
    r"^(?:apphosting(?:\.[\w-]+)?|docker-compose(?:\.[\w-]+)?|compose(?:\.[\w-]+)?|cloudbuild(?:\.[\w-]+)?|app|render)\.ya?ml$",
    re.I,
)
JSON_DEPLOY_NAMES = frozenset({"vercel.json", "firebase.json"})
TOML_DEPLOY_NAMES = frozenset({"fly.toml", "netlify.toml"})

# A workflow job serves the Next or eve runtime when it builds, starts or deploys it (spec R9a). Other jobs (the Functions
# suites, the corpus jobs, the coding-agent workflows that hand ANTHROPIC_API_KEY to anthropics/claude-code-action) are
# CI tooling, not the product runtime, and are outside this rule.
SERVES_NEXT_RE = re.compile(
    r"\bnext\s+(?:build|start|dev)\b"
    r"|\bnpm\s+(?:run\s+)?(?:build|start|dev)\b(?![^\n]*--prefix\s+functions)"
    r"|\bnpm\s+run\s+eve:"
    r"|\beve\s+(?:dev|start|build|deploy)\b"
    r"|\bvercel\b"
    r"|\bfirebase\s+deploy\b"
    r"|\bapphosting\b"
    r"|uses:\s*\S*(?:hosting-deploy|vercel|apphosting|deploy-cloudrun|deploy-appengine)",
    re.I,
)
JOB_HEADER_RE = re.compile(r"^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$")


def banned_package(root: str) -> bool:
    name = root.lower()
    if name in ALLOWED_AI_SDK_PACKAGES:
        return False
    if name == "ai" or name.startswith("@ai-sdk/"):
        return True
    return name in SDK_PACKAGE_SET or name in EXTRA_SDK_PACKAGES


def is_env_file(name: str) -> bool:
    return name == ".env" or name.startswith(".env.") or (name.endswith(".env") and len(name) > 4)


def deploy_kind(rel: str) -> str | None:
    name = rel.rsplit("/", 1)[-1]
    if is_env_file(name):
        return "env"
    if rel.startswith(".github/workflows/") and re.search(r"\.ya?ml$", name, re.I):
        return "workflow"
    if YAML_DEPLOY_RE.match(name):
        return "yaml"
    if name in TOML_DEPLOY_NAMES:
        return "toml"
    if name in JSON_DEPLOY_NAMES:
        return "json"
    if DOCKERFILE_NAME_RE.match(name):
        return "dockerfile"
    return None


def _module_id(path: str) -> str:
    """Drop a JS/TS extension and a trailing /index, so transport.ts and transport/index.js are one module."""
    p = _JS_EXT_RE.sub("", path)
    return p[: -len("/index")] if p.endswith("/index") else p


def resolve_repo_module(spec: str, importer: str) -> str | None:
    """Repository path a literal specifier names, or None for a package, URL or a path that leaves the repo."""
    raw = spec.strip().split("?", 1)[0].split("#", 1)[0].strip()
    if not raw:
        return None
    if ":" in raw.split("/", 1)[0]:
        return None
    if raw.startswith("@/"):
        path = raw[2:]
    elif raw.startswith(("./", "../")) or raw in {".", ".."}:
        path = posixpath.normpath(posixpath.join(posixpath.dirname(importer), raw))
    elif raw.startswith("/"):
        return None
    else:
        path = raw
    path = posixpath.normpath(_module_id(path))
    if path == ".." or path.startswith("../"):
        return None
    return path


def is_functions_paid_module(module: str) -> bool:
    return any(module == banned or module.startswith(banned + "/") for banned in FUNCTIONS_P1_PAID_MODULES)


def functions_paid_import_findings(rel: str, text: str) -> list[str]:
    """Rule (e): a file outside functions/ importing the Functions P1 transport or gateway."""
    specs = js_module_specifiers(text)
    specs += [m.group(2) for m in _TEST_LOADER_RE.finditer(text)]
    found: set[str] = set()
    for spec in specs:
        module = resolve_repo_module(spec, rel)
        if module is not None and is_functions_paid_module(module):
            found.add(module)
    return [
        f"{rel}: imports {module} (a Functions P1 transport/provider module; paid calls stay in the Functions runtime)"
        for module in sorted(found)
    ]


def source_findings(rel: str, text: str) -> list[str]:
    out: list[str] = []
    for root in sorted(js_imported_packages(text)):
        if banned_package(root):
            out.append(f"{rel}: imports {root} (a paid AI client; the only paid path is Cloud Functions P1)")
    if rel != KEY_GUARD_FILE:
        for name in sorted({m.group(1) for m in KEY_RE.finditer(text)}):
            out.append(f"{rel}: names provider key {name} (only {KEY_GUARD_FILE} may)")
    for host in sorted({m.group(1).lower() for m in HOST_RE.finditer(text)}):
        out.append(f"{rel}: names provider host {host}")
    return out


def _keys_in(lines: list[str]) -> set[str]:
    return {m.group(1) for line in lines if not line.lstrip().startswith("#") for m in KEY_RE.finditer(line)}


def workflow_keys(text: str) -> set[str]:
    """Provider keys a workflow hands to a job that builds, starts or deploys the Next/eve service (spec R9a).

    The top level before `jobs:` (workflow `env:`) reaches every job; each job is the block under a two-space key in `jobs:`.
    """
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if re.match(r"^jobs:\s*(?:#.*)?$", line))
    except StopIteration:
        return set()
    top = lines[:start]
    jobs: list[list[str]] = []
    for line in lines[start + 1 :]:
        if JOB_HEADER_RE.match(line):
            jobs.append([])
        elif jobs:
            jobs[-1].append(line)
    serving = [job for job in jobs if any(SERVES_NEXT_RE.search(line) for line in job if not line.lstrip().startswith("#"))]
    if not serving:
        return set()
    found = _keys_in(top)
    for job in serving:
        found |= _keys_in(job)
    return found


def deploy_findings(rel: str, kind: str, text: str) -> list[str]:
    out: set[str] = set()
    if kind == "workflow":
        out = workflow_keys(text)
    for line in text.splitlines() if kind != "workflow" else []:
        if kind == "env":
            m = ENV_ASSIGN_RE.match(line)
            if m:
                out.add(m.group(1))
            continue
        if kind != "json" and line.lstrip().startswith("#"):
            continue
        for m in KEY_RE.finditer(line):
            out.add(m.group(1))
    return [f"{rel}: binds provider key {name} for the Next/eve service (the key belongs to the Functions api function only)" for name in sorted(out)]


def findings_for(p: pathlib.Path) -> list[str]:
    rel = rel_posix(p)
    if rel.startswith(FUNCTIONS_PREFIX):
        return []
    text = read_text(p) if file_kind(p) == "js" else None
    paid = [] if text is None else functions_paid_import_findings(rel, text)
    # corpus_service stays exempt from (a)-(d) (the F27 lane). Rule (e) still applies: it may not import the paid modules.
    if rel.startswith("corpus_service/"):
        return paid
    kind = deploy_kind(rel)
    if kind is not None:
        body = text if text is not None else read_text(p)
        return [] if body is None else deploy_findings(rel, kind, body)
    if text is None:
        return []
    return paid + source_findings(rel, text)


def main(argv: list[str]) -> int:
    if "--print-key-names" in argv:
        print(json.dumps(list(PROVIDER_KEY_ENV_NAMES)))
        return 0
    failures: list[str] = []
    for p in iter_scan_files():
        failures.extend(findings_for(p))
    if failures:
        print("FAIL: a paid AI path outside Cloud Functions P1 in the Next/eve runtime (audit F18):")
        for f in sorted(set(failures)):
            print(" ", f)
        return 1
    print("PASS: no AI SDK, provider SDK, provider key or provider host in the Next/eve runtime; no deploy surface binds a provider key")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
