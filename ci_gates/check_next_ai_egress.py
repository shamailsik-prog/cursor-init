#!/usr/bin/env python3
"""next-ai-egress guard (audit F18; G-0 check [19]).

No paid AI call may leave the Next or eve runtime except through the Cloud Functions P1 control plane
(`/api/platform/brain/committeeBrain`: kill switches, budget, cost log). Spec:
docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md, rulings R9 and R13 (re-audit follow-up).

Scope of rules (a)-(e): every file the G-0 walker scans (g0_guard_common.iter_scan_files: tests/, ci_gates/, generated
trees and the eve cache are skipped), except
  - functions/       the control plane itself (which code there may hold a provider SDK is G-0 [3]'s rule), and
  - corpus_service/  the embedding worker (the F27 lane; FA-D3C-002 is allowlisted under G-0 [3]).

It fails on any of:
  (a) JS/TS importing the `ai` SDK, any `@ai-sdk/*` package other than `@ai-sdk/provider` (types and error classes, no
      network code), or a provider SDK (G-0 [3]'s list plus EXTRA_SDK_PACKAGES): import, export-from, import(),
      require(), type-only imports included, and a specifier that a root tsconfig `paths` alias resolves into
      node_modules/<that package> (attack P12);
  (b) JS/TS naming a provider key variable (PROVIDER_KEY_ENV_NAMES), except platform/p1/providerKeyGuard.ts, the runtime
      guard that refuses them;
  (c) JS/TS naming a provider API host (PROVIDER_HOSTS);
  (d) a deploy surface binding a provider key: `.env`, `.env.*`, `*.env`, `.envrc` and `.envrc.*` files (an assignment,
      commented templates included); App Hosting, compose, Cloud Build, App Engine and Render YAML, vercel.json,
      firebase.json, fly.toml, netlify.toml and Dockerfiles (any non-comment line naming a key); and a GitHub workflow
      job, at any indentation, that builds, starts or deploys the Next/eve service (SERVES_NEXT_RE), or the
      workflow-level env such a job inherits (spec R9a). Workflow jobs that do not serve that runtime (the Functions
      suites, the coding-agent workflows) are CI tooling and out of scope;
  (e) a file under agent/ that gives eve a model as a string (`model: "vendor/model"` in JS/TS, a `model:` value in
      front matter, YAML or JSON): eve's model is the P1 LanguageModel, an identifier, never a Gateway model string.

Rules over the whole tree (re-audit follow-up, FA-F18-001a and FA-F18-002, spec ruling R13):
  (f) no JS/TS outside functions/ (root tests/ included) imports a module under functions/: `@/functions/...`, a
      relative path, a root tsconfig `paths` alias or `baseUrl` that resolves there, `require(...)`, `import(...)`,
      createRequire loaders and vitest/jest `importActual`/`requireActual`/`importMock`/`requireMock`, each with a
      literal specifier. The one exception is FUNCTIONS_IMPORT_ALLOWLIST: a root test file importing a named Functions
      module, with a one-line reason. The transport and the gateway (NEVER_ALLOWLISTED) can never be on it, an entry for
      anything outside tests/ is refused, and an entry whose file no longer imports its module is stale;
  (g) no JS/TS outside functions/ names the Functions runtime marker (FUNCTIONS_RUNTIME_MARKER), the compile-time
      constant functions/build.mjs defines in the Functions bundles, which alone lets the Functions transport build a
      paid transport;
  (h) no symlinked directory anywhere outside node_modules/.git/.next: the walkers do not follow links, so what is
      behind one would go unchecked (attack P40);
  (i) every root tsconfig*.json / jsconfig.json must parse (JSON with comments and trailing commas), or its aliases
      cannot be checked.

Known limits (spec R9, residuals): computed specifiers and hosts, `package.json` `imports` maps, npm alias dependencies,
SDKs not on the lists, aliases set only in JS config (vitest, next, webpack), `vi.mock`/`vi.doMock` (a replacement, not
an import), flow-style or anchored workflow YAML, `gcloud run deploy` / `docker build` / `pnpm build` jobs, and shell
scripts.

`--print-key-names` prints PROVIDER_KEY_ENV_NAMES as JSON (tests/f18-next-ai-egress-gate.test.ts holds it equal to the
runtime guard's list and to a pinned list). `--print-functions-allowlist` prints FUNCTIONS_IMPORT_ALLOWLIST as JSON.
"""
from __future__ import annotations

import json
import os
import pathlib
import posixpath
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from check_provider_imports import SDK_PACKAGE_SET  # noqa: E402
from g0_guard_common import (  # noqa: E402
    ANY_DEPTH_SKIP_DIRS,
    DOCKERFILE_NAME_RE,
    _JS_SPECIFIER_RE,
    _create_require_specifiers,
    file_kind,
    iter_scan_files,
    js_imported_packages,
    js_package_root,
    read_text,
    rel_posix,
)

EXEMPT_PREFIXES = ("functions/", "corpus_service/")
KEY_GUARD_FILE = "platform/p1/providerKeyGuard.ts"

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
        "@aws-sdk/client-bedrock-agent-runtime",
        "@azure/openai",
        "@google-cloud/aiplatform",
        "@google-cloud/vertexai",
        "@google-cloud/text-to-speech",
        "@fal-ai/client",
        "@elevenlabs/elevenlabs-js",
        "@deepgram/sdk",
        "assemblyai",
        # Re-audit follow-up (FA-F18-002, attacks P35-P37).
        "@anthropic-ai/vertex-sdk",
        "@anthropic-ai/bedrock-sdk",
        "@langchain/openai",
        "@langchain/anthropic",
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
JOBS_LINE_RE = re.compile(r"^jobs\s*:\s*(?:#.*)?$")

# --- re-audit follow-up (spec ruling R13) ------------------------------------------------------------------------------

FUNCTIONS_DIR = "functions"
# The compile-time constant functions/build.mjs defines (functions/runtime-define.mjs) in the Functions bundles; the
# Functions transport builds a paid transport only where it is defined.
FUNCTIONS_RUNTIME_MARKER = "__SIKANDER_FUNCTIONS_RUNTIME__"
# Never importable from outside functions/, whatever an allowlist entry says.
NEVER_ALLOWLISTED = ("functions/src/p1/transport", "functions/src/p1/gateway")

# (importer, Functions module) -> why that root test file may import it. Modules are repository paths without extension
# or /index. Only tests/ files; never NEVER_ALLOWLISTED; an entry whose file no longer imports its module is stale.
FUNCTIONS_IMPORT_ALLOWLIST: dict[tuple[str, str], str] = {
    ("tests/f18-legacy-ai-path.e2e.firestore.test.ts", "functions/src/http/router"): "the F18 e2e serves the real Functions api router in process, as deployed",
    ("tests/f18-legacy-ai-path.e2e.firestore.test.ts", "functions/src/health"): "pins the Functions api timeout below Next's forward deadline (FUNCTION_TIMEOUT_SECONDS)",
    ("tests/f18-legacy-ai-path.e2e.firestore.test.ts", "functions/src/p1/transportTestSeam"): "installs the Functions fake transport; the seam holds no paid code and refuses in production",
    ("tests/helpers/functions-router-fetch.ts", "functions/src/http/router"): "F02 console e2e helper: calls the real Functions api router in process",
    ("tests/helpers/functions-router-fetch.ts", "functions/test/emu"): "F02 console e2e helper: the Functions suite's mock express response (mockRes)",
    ("tests/f11-atomic-request-audit.e2e.firestore.test.ts", "functions/src/p5/auditOutbox"): "F11 e2e: runs the Functions audit-outbox reconciler (a Firestore handle in; no transport) on what Next left",
    ("tests/f11-audit-outbox.firestore.test.ts", "functions/src/p5/auditOutbox"): "F11: drives the Functions audit-outbox reconciler (a Firestore handle in; no transport) on the emulator",
    ("tests/f13-canonical-matter-shapes.e2e.firestore.test.ts", "functions/test/api"): "F13 cross-stack e2e: calls the Functions api router in process (viaApi)",
    ("tests/f13-canonical-matter-shapes.e2e.firestore.test.ts", "functions/test/emu"): "F13 cross-stack e2e: the Functions suite's emulator ID tokens and ids",
    ("tests/f13-reaudit.e2e.firestore.test.ts", "functions/test/api"): "F13 re-audit e2e: calls the Functions api router in process (viaApi)",
    ("tests/f13-reaudit.e2e.firestore.test.ts", "functions/test/emu"): "F13 re-audit e2e: the Functions suite's emulator ID tokens and ids",
    ("tests/f13-slice2.e2e.firestore.test.ts", "functions/test/api"): "F13 slice 2 e2e: calls the Functions api router in process (viaApi)",
    ("tests/f13-slice2.e2e.firestore.test.ts", "functions/test/emu"): "F13 slice 2 e2e: the Functions suite's emulator ID tokens and ids",
    ("tests/f13-slice2.e2e.firestore.test.ts", "functions/src/admin"): "F13 slice 2 e2e: reads what the Functions stack wrote through its own Admin handle",
    ("tests/p5.identity-policy.parity.test.ts", "functions/src/p5/auth"): "P5 parity: the Functions identity policy must equal the Next one",
    ("tests/p5.permission-decision.parity.test.ts", "functions/src/p5/permission"): "P5 parity: the Functions permission decision must equal the Next one",
}

ROOT_TS_CONFIG_RE = re.compile(r"^(?:tsconfig(?:\.[\w-]+)*|jsconfig)\.json$")
# The repository's root alias (tsconfig, vitest and the Functions esbuild build all map `@` to the root); applied even
# when no tsconfig says so.
DEFAULT_ALIASES: tuple[tuple[str, tuple[str, ...], str], ...] = (("@/*", ("./*",), "."),)
JS_EXT_RE = re.compile(r"\.(?:d\.)?(?:[cm]?[jt]sx?)$")
_LITERAL = r"""(["'`])([^"'`\r\n]+)\1"""
TEST_LOADER_RE = re.compile(
    r"\b(?:vi|jest)\s*\.\s*(?:importActual|requireActual|importMock|requireMock)\s*(?:<[^>()]*>)?\s*\(\s*" + _LITERAL
)
AGENT_PREFIX = "agent/"
AGENT_MODEL_JS_RE = re.compile(r"""(?<![\w$])["']?model["']?\s*:\s*(["'`])([^"'`\r\n]*)\1""")
AGENT_MODEL_TEXT_RE = re.compile(r"""^\s*["']?model["']?\s*:\s*["'`]?([^\s"'`#,]+)""", re.M)
AGENT_TEXT_SUFFIXES = frozenset({".md", ".mdx", ".yml", ".yaml", ".json", ".toml"})

Alias = tuple[str, tuple[str, ...], str]


def banned_package(root: str) -> bool:
    name = root.lower()
    if name in ALLOWED_AI_SDK_PACKAGES:
        return False
    if name == "ai" or name.startswith("@ai-sdk/"):
        return True
    return name in SDK_PACKAGE_SET or name in EXTRA_SDK_PACKAGES


def is_env_file(name: str) -> bool:
    if name == ".envrc" or name.startswith(".envrc."):
        return True
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


# --- module specifiers and their resolution ----------------------------------------------------------------------------


def js_specifiers(text: str) -> list[str]:
    """Every literal module specifier a JS/TS file loads: import/export-from, import(), require(), require.resolve(),
    createRequire loaders, and the vitest/jest loaders of the real module."""
    specs = [m.group("s1") or m.group("s2") or "" for m in _JS_SPECIFIER_RE.finditer(text)]
    specs += _create_require_specifiers(text)
    specs += [m.group(2) for m in TEST_LOADER_RE.finditer(text)]
    return [s.strip() for s in specs if s.strip()]


def _strip_jsonc(text: str) -> str:
    """JSON with comments and trailing commas (tsconfig's dialect) as plain JSON."""
    out: list[str] = []
    i, n = 0, len(text)
    in_string = False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    plain = "".join(out)
    # Trailing commas, outside strings.
    result: list[str] = []
    in_string = False
    i, n = 0, len(plain)
    while i < n:
        c = plain[i]
        if in_string:
            result.append(c)
            if c == "\\" and i + 1 < n:
                result.append(plain[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            result.append(c)
        elif c == ",":
            j = i + 1
            while j < n and plain[j] in " \t\r\n":
                j += 1
            if j >= n or plain[j] not in "}]":
                result.append(c)
        else:
            result.append(c)
        i += 1
    return "".join(result)


def load_path_aliases(root: pathlib.Path) -> tuple[list[Alias], list[str], list[str]]:
    """The `paths` aliases and `baseUrl`s of every root tsconfig*.json / jsconfig.json, plus the repository's `@` alias;
    and a failure for each such file that does not parse (rule (i))."""
    aliases: list[Alias] = []
    base_urls: list[str] = []
    failures: list[str] = []
    for p in sorted(root.iterdir()):
        if not ROOT_TS_CONFIG_RE.match(p.name) or not p.is_file():
            continue
        try:
            data = json.loads(_strip_jsonc(read_text(p) or ""))
        except ValueError:
            failures.append(f"{p.name}: cannot be parsed as JSON with comments, so [19] cannot check its path aliases")
            continue
        options = data.get("compilerOptions") if isinstance(data, dict) else None
        if not isinstance(options, dict):
            continue
        base = options.get("baseUrl")
        base_rel = posixpath.normpath(base) if isinstance(base, str) and base.strip() else "."
        if isinstance(base, str) and base.strip():
            base_urls.append(base_rel)
        paths = options.get("paths")
        if isinstance(paths, dict):
            for pattern, targets in paths.items():
                if isinstance(pattern, str) and isinstance(targets, list):
                    aliases.append((pattern, tuple(t for t in targets if isinstance(t, str)), base_rel))
    aliases.extend(DEFAULT_ALIASES)
    return aliases, base_urls, failures


def _alias_capture(pattern: str, spec: str) -> str | None:
    if "*" not in pattern:
        return "" if spec == pattern else None
    prefix, suffix = pattern.split("*", 1)
    if spec.startswith(prefix) and spec.endswith(suffix) and len(spec) >= len(prefix) + len(suffix):
        return spec[len(prefix) : len(spec) - len(suffix)]
    return None


def alias_targets(spec: str, aliases: list[Alias]) -> list[str]:
    out: list[str] = []
    for pattern, targets, base in aliases:
        capture = _alias_capture(pattern, spec)
        if capture is None:
            continue
        for target in targets:
            out.append(posixpath.normpath(posixpath.join(base, target.replace("*", capture, 1))))
    return out


def resolve_specifier(spec: str, importer: str, aliases: list[Alias], base_urls: list[str]) -> list[str]:
    """Repository paths a specifier can name (normalised, no extension handling); none outside the repository."""
    if ":" in spec.split("/", 1)[0]:
        return []  # node:, npm:, URLs
    if spec in (".", "..") or spec.startswith(("./", "../")):
        found = [posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))]
    elif spec.startswith("/"):
        rel = os.path.relpath(spec, os.getcwd()).replace(os.sep, "/")
        found = [posixpath.normpath(rel)]
    else:
        found = alias_targets(spec, aliases)
        found += [posixpath.normpath(posixpath.join(base, spec)) for base in base_urls]
        found.append(posixpath.normpath(spec))  # a bare path from the root (baseUrl ".")
    return [f for f in found if f != ".." and not f.startswith("../")]


def module_id(path: str) -> str:
    p = JS_EXT_RE.sub("", path)
    return p[: -len("/index")] if p.endswith("/index") else p


def under_functions(path: str) -> bool:
    return path == FUNCTIONS_DIR or path.startswith(FUNCTIONS_DIR + "/")


def node_modules_package(path: str) -> str | None:
    """The npm package a resolved alias target names inside node_modules, if any."""
    idx = path.rfind("node_modules/")
    if idx < 0 or (idx > 0 and path[idx - 1] != "/"):
        return None
    return js_package_root(path[idx + len("node_modules/") :])


# --- rules (a)-(e) -----------------------------------------------------------------------------------------------------


def source_findings(rel: str, text: str, aliases: list[Alias] | None = None) -> list[str]:
    out: list[str] = []
    for root in sorted(js_imported_packages(text)):
        if banned_package(root):
            out.append(f"{rel}: imports {root} (a paid AI client; the only paid path is Cloud Functions P1)")
    for spec in sorted(set(js_specifiers(text))):
        for target in alias_targets(spec, aliases or []):
            pkg = node_modules_package(target)
            if pkg and banned_package(pkg):
                out.append(f'{rel}: imports {pkg} through the path alias "{spec}" (a paid AI client; the only paid path is Cloud Functions P1)')
    if rel != KEY_GUARD_FILE:
        for name in sorted({m.group(1) for m in KEY_RE.finditer(text)}):
            out.append(f"{rel}: names provider key {name} (only {KEY_GUARD_FILE} may)")
    for host in sorted({m.group(1).lower() for m in HOST_RE.finditer(text)}):
        out.append(f"{rel}: names provider host {host}")
    return out


def _keys_in(lines: list[str]) -> set[str]:
    return {m.group(1) for line in lines if not line.lstrip().startswith("#") for m in KEY_RE.finditer(line)}


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_content(line: str) -> bool:
    s = line.strip()
    return s != "" and not s.startswith("#")


def workflow_sections(text: str) -> tuple[list[str], list[list[str]]]:
    """A workflow's top level (every section but `jobs:`, wherever it sits) and its jobs, at any indentation: a job is
    the block that starts at the indentation of the first content line under `jobs:` (FA-F18-002, attack P27)."""
    top: list[str] = []
    jobs: list[list[str]] = []
    in_jobs = False
    job_indent: int | None = None
    for line in text.splitlines():
        if _is_content(line) and _indent(line) == 0:
            in_jobs = bool(JOBS_LINE_RE.match(line))
            if not in_jobs:
                top.append(line)
            continue
        if not in_jobs:
            top.append(line)
            continue
        if not _is_content(line):
            if jobs:
                jobs[-1].append(line)
            continue
        indent = _indent(line)
        if job_indent is None:
            job_indent = indent
        if indent <= job_indent or not jobs:
            jobs.append([line])
        else:
            jobs[-1].append(line)
    return top, jobs


def workflow_keys(text: str) -> set[str]:
    """Provider keys a workflow hands to a job that builds, starts or deploys the Next/eve service (spec R9a): the job's
    own lines, and the workflow-level env every job inherits."""
    top, jobs = workflow_sections(text)
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


def agent_model_findings(rel: str, p: pathlib.Path) -> list[str]:
    """Rule (e): a string model under agent/ (attack P39)."""
    suffix = p.suffix.lower()
    kind = file_kind(p)
    if kind != "js" and suffix not in AGENT_TEXT_SUFFIXES:
        return []
    text = read_text(p)
    if text is None:
        return []
    values = [m.group(2) for m in AGENT_MODEL_JS_RE.finditer(text)] if kind == "js" else [m.group(1) for m in AGENT_MODEL_TEXT_RE.finditer(text)]
    return [
        f"{rel}: gives eve the model string {value or '(empty)'}; eve's model is the P1 LanguageModel (platform/p1/committeeBrainModel.ts), never a Gateway model string"
        for value in sorted(set(values))
    ]


def findings_for(p: pathlib.Path, aliases: list[Alias] | None = None) -> list[str]:
    rel = rel_posix(p)
    if rel.startswith(EXEMPT_PREFIXES):
        return []
    out = agent_model_findings(rel, p) if rel.startswith(AGENT_PREFIX) else []
    kind = deploy_kind(rel)
    if kind is not None:
        text = read_text(p)
        return out + ([] if text is None else deploy_findings(rel, kind, text))
    if file_kind(p) != "js":
        return out
    text = read_text(p)
    return out + ([] if text is None else source_findings(rel, text, aliases))


# --- rules (f)-(h) -----------------------------------------------------------------------------------------------------


def symlinked_dirs(root: pathlib.Path) -> list[str]:
    """Rule (h): every symlinked directory outside node_modules/.git/.next (attack P40)."""
    out: list[str] = []
    for dirpath, dirnames, _ in os.walk(root):
        rel_dir = pathlib.Path(dirpath).relative_to(root)
        keep: list[str] = []
        for d in dirnames:
            if d in ANY_DEPTH_SKIP_DIRS:
                continue
            if (pathlib.Path(dirpath) / d).is_symlink():
                out.append(rel_posix(rel_dir / d))
            else:
                keep.append(d)
        dirnames[:] = sorted(keep)
    return sorted(out)


def iter_tree_js(root: pathlib.Path):
    """Every JS/TS file outside functions/, root tests/ included; node_modules/.git/.next pruned at any depth, the root
    .eve cache pruned; symlinked directories are not followed (rule (h) reports them)."""
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = pathlib.Path(dirpath).relative_to(root)
        at_root = not rel_dir.parts
        dirnames[:] = sorted(d for d in dirnames if d not in ANY_DEPTH_SKIP_DIRS and not (at_root and d in (FUNCTIONS_DIR, ".eve")))
        for name in sorted(filenames):
            rel = rel_dir / name
            p = root / rel
            if p.is_file() and file_kind(p) == "js":
                yield rel


def allowlist_problems() -> list[str]:
    out: list[str] = []
    for (importer, module), reason in FUNCTIONS_IMPORT_ALLOWLIST.items():
        mid = module_id(module)
        if any(mid == n or mid.startswith(n + "/") for n in NEVER_ALLOWLISTED):
            out.append(f"{importer}: the Functions import allowlist names {module}; the transport and the gateway are never allowlisted (spec ruling R13)")
        if not importer.startswith("tests/"):
            out.append(f"{importer}: the Functions import allowlist names a file outside tests/; only a root test file may import Functions code")
        if not under_functions(module):
            out.append(f"{importer}: the Functions import allowlist entry {module} is not a Functions module")
        if len(reason.strip()) < 10:
            out.append(f"{importer}: the Functions import allowlist entry for {module} has no reason")
    return out


def functions_import_findings(root: pathlib.Path, aliases: list[Alias], base_urls: list[str]) -> list[str]:
    """Rules (f) and (g), and stale allowlist entries."""
    out: list[str] = []
    imports_of: dict[str, set[str]] = {}
    for rel_path in iter_tree_js(root):
        rel = rel_posix(rel_path)
        text = read_text(root / rel_path)
        if text is None:
            continue
        if FUNCTIONS_RUNTIME_MARKER in text:
            out.append(f"{rel}: names the Functions runtime marker {FUNCTIONS_RUNTIME_MARKER} (only functions/build.mjs may define it)")
        modules = {
            module_id(target)
            for spec in js_specifiers(text)
            for target in resolve_specifier(spec, rel, aliases, base_urls)
            if under_functions(target)
        }
        imports_of[rel] = modules
        for module in sorted(modules):
            if (rel, module) in FUNCTIONS_IMPORT_ALLOWLIST:
                continue
            out.append(
                f"{rel}: imports {module}; nothing outside functions/ may import the Cloud Functions tree "
                "(a root test may import a module FUNCTIONS_IMPORT_ALLOWLIST names; never the transport or the gateway)"
            )
    for importer, module in FUNCTIONS_IMPORT_ALLOWLIST:
        if importer in imports_of and module not in imports_of[importer]:
            out.append(f"{importer}: stale Functions import allowlist entry for {module} (the file no longer imports it; remove the entry)")
    return out


def main(argv: list[str]) -> int:
    if "--print-key-names" in argv:
        print(json.dumps(list(PROVIDER_KEY_ENV_NAMES)))
        return 0
    if "--print-functions-allowlist" in argv:
        print(json.dumps([{"importer": i, "module": m, "reason": r} for (i, m), r in FUNCTIONS_IMPORT_ALLOWLIST.items()]))
        return 0
    root = pathlib.Path(".")
    aliases, base_urls, failures = load_path_aliases(root)
    failures += allowlist_problems()
    failures += [
        f"{d}: a symlinked directory; [19] does not follow links, so what is behind it would go unchecked (replace it with the files)"
        for d in symlinked_dirs(root)
    ]
    for p in iter_scan_files():
        failures.extend(findings_for(p, aliases))
    failures.extend(functions_import_findings(root, aliases, base_urls))
    if failures:
        print("FAIL: a paid AI path outside Cloud Functions P1 in the Next/eve runtime (audit F18):")
        for f in sorted(set(failures)):
            print(" ", f)
        return 1
    print(
        "PASS: no AI SDK, provider SDK, provider key or provider host in the Next/eve runtime; no deploy surface binds a "
        "provider key; nothing outside functions/ imports the Functions tree beyond the test allowlist"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
