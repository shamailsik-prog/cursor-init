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
  (d) a deploy surface binding a provider key: `.env`, `.env.*`, `*.env`, `.envrc` and `.envrc.*` files (an assignment,
      commented templates included; FA-F18-002); App Hosting, compose, Cloud Build, App Engine and Render YAML,
      vercel.json, firebase.json, fly.toml, netlify.toml and Dockerfiles (any non-comment line naming a key); and a
      GitHub workflow job that builds, starts or deploys the Next/eve service (SERVES_NEXT_RE), at the indentation of
      the first job under `jobs:` (two spaces or four; FA-F18-002), or the workflow-level env above such a job (spec
      R9a). Workflow jobs that do not serve that runtime (the Functions suites, the coding-agent workflows) are CI
      tooling and out of scope;
  (e) any JS/TS file outside functions/ (corpus_service/ included; the G-0 walker still skips root tests/) importing a
      Functions module that is not on FUNCTIONS_PURE_MODULES (costTable, types, and the F02 router boundary). The specifier
      may be the `@/` alias, a relative path, a bare `functions/...` path, an extension or `/index`, with a query or hash
      stripped. Forms: import, export-from, import(), require(), require.resolve(), createRequire, and vitest/jest
      importActual, requireActual, importMock and requireMock, including a nested type argument such as
      `vi.importActual<Record<string, unknown>>(...)` (FA-F18-011). A block or line comment may sit between those loader
      tokens, the same gap the import parser allows (FA-F18-009). functions/ itself may import these modules. The only
      modules outside functions/ may import are the pure ones on FUNCTIONS_PURE_MODULES (FA-F18-010).
  (f) under `agent/` (eve), the model passed to `defineAgent` must resolve (TypeScript checker) to the
      `committeeBrainLanguageModel` export from the module that resolves exactly to `platform/p1/committeeBrainModel`
      (exact path equality; FA-F18-002, FA-F18-012, FA-F18-015, FA-F18-016, FA-F18-020). When `agent/` exists,
      `agent/agent.ts` is the only permitted entry (`agent/agent.{js,jsx,mjs,cjs,mts,cts,tsx}` forbidden). JS/TS
      (including `.mts`/`.cts`) is checked with a TypeScript AST pass: `agent/agent.ts` must have exactly one non-type
      `import { defineAgent } from "eve"` and `export default defineAgent({...})` where the callee is that import (not a
      local wrapper); no namespace/default `eve` import, no `x.defineAgent` / dynamic `import("eve")` / `require("eve")`,
      no local `defineAgent` binding; only `agent/agent.ts` may import `{ defineAgent }` from `"eve"`; in that file every
      `defineAgent` reference must be the callee of a direct `defineAgent({...})` call (no `.call`/`.apply`/`.bind` or
      passing the import elsewhere); exactly one eve `defineAgent` call under `agent/`; object-literal argument without
      spread; no bare side-effect `import "..."` under `agent/` (FA-F18-031); no dynamic `import()` or `require()` under
      `agent/` (FA-F18-032); no non-type import under `agent/` of any module that transitively imports
      `platform/p1/committeeBrainModel` except the direct `{ committeeBrainLanguageModel }` import from that module
      (FA-F18-032, so mutation of the canonical model in other files cannot run via a pulled-in module); no re-export
      (`export *` / `export { ... } from`) from outside `agent/` (FA-F18-033); outside `functions/`, only
      `agent/agent.ts` may import `"eve"`, name `defineAgent`, or call `defineAgent` (FA-F18-033). Under `agent/` only,
      no mutation of `committeeBrainLanguageModel` (property/element/compound/logical assignment, `delete`, `++`/`--`,
      or `Object`/`Reflect` APIs, including when `Object`/`Reflect` are aliased to a local); the
      `committeeBrainLanguageModel` identifier may appear only as the `model:` value in that single `defineAgent`
      argument (FA-F18-029); `Object.assign` / object spreads under `agent/` only from object literals declared in the
      same file; no local shadowing of `committeeBrainLanguageModel` or `model` parameters; no `.model` / computed
      model-key / `Object.defineProperty` / `Object.assign` / `Reflect.set` / logical-assignment writes on other
      objects; no other `model` property under `agent/`. Quoted model strings in JSON/YAML/markdown under `agent/` fail.
      Residual: non-`const` computed property keys on arbitrary objects; mutation of `committeeBrainLanguageModel` in
      files that are not imported (directly or transitively) from `agent/`.
  (g) a symlinked directory. The walk does not follow links, so the directory itself fails the gate (FA-F18-002).

Rules (a)-(d) have no allowlist beyond the one key-guard file. `--print-key-names` prints PROVIDER_KEY_ENV_NAMES as JSON;
`--print-pure-modules` prints FUNCTIONS_PURE_MODULES (tests/f18-functions-pure-closure.test.ts holds it equal to the gate).
"""
from __future__ import annotations

import json
import os
import pathlib
import posixpath
import re
import subprocess
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

# Outside functions/, an import of the Functions tree is allowed only when it names one of these modules.
# costTable and types are pure data. f02RouterBoundary is the one F02 entry (FA-F18-013/014): Next names it; inside
# functions/ it builds createRouter(F02_NEXT_AUTHORITY_ROUTES) only. The full router (ROUTES, p1/ops) is not on this list.
FUNCTIONS_PURE_MODULES = (
    "functions/src/p1/costTable",
    "functions/src/p1/types",
    "functions/src/http/f02RouterBoundary",
)
_JS_EXT_RE = re.compile(r"\.(?:[cm]?[jt]sx?)$", re.I)
# Same comment-aware gap as g0_guard_common.JS_WS (FA-F18-009). The type argument allows one nested `<>`
# (`Record<string, unknown>`); `[^<>()]*` alone misses it (FA-F18-011). DOTALL so a block comment may contain a newline.
_NESTED_TYPE_ARG = r"(?:<(?:[^<>()]|<[^<>()]*>)*>)?"
_TEST_LOADER_RE = re.compile(
    rf"""\b(?:vi|jest){JS_WS}\.{JS_WS}(?:importActual|requireActual|importMock|requireMock){JS_WS}{_NESTED_TYPE_ARG}{JS_WS}\({JS_WS}(["'`])([^"'`\r\n]+)\1""",
    re.DOTALL,
)
# A quoted `model` value in JS/TS, and a `model:` value in eve's YAML, JSON or markdown (FA-F18-002).
# FA-F18-015/016: rule (f) allowlist — AST check for JS/TS (ci_gates/check_agent_eve_model.ts); quoted models in text formats.
_COMMITTEE_BRAIN_MODEL = "committeeBrainLanguageModel"
_AGENT_QUOTED_MODEL_RE = re.compile(r"""["']model["']\s*:\s*["']([^"']+)["']""")
_AGENT_MODEL_TEXT_RE = re.compile(r"""^\s*["']?model["']?\s*:\s*["'`]?([^\s"'`#,]+)""", re.M)
_AGENT_TEXT_SUFFIXES = frozenset({".md", ".mdx", ".yml", ".yaml", ".json", ".toml"})

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
JOBS_LINE_RE = re.compile(r"^jobs\s*:\s*(?:#.*)?$")


def banned_package(root: str) -> bool:
    name = root.lower()
    if name in ALLOWED_AI_SDK_PACKAGES:
        return False
    if name == "ai" or name.startswith("@ai-sdk/"):
        return True
    return name in SDK_PACKAGE_SET or name in EXTRA_SDK_PACKAGES


def is_env_file(name: str) -> bool:
    # direnv's .envrc is an env file (FA-F18-002). `.envrc.local` is the same family.
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


def is_functions_module(module: str) -> bool:
    return module == "functions" or module.startswith("functions/")


def is_functions_pure_module(module: str) -> bool:
    return module in FUNCTIONS_PURE_MODULES


def functions_import_findings(rel: str, text: str) -> list[str]:
    """Rule (e): outside functions/, only FUNCTIONS_PURE_MODULES may be imported from the Functions tree (FA-F18-010)."""
    specs = js_module_specifiers(text)
    specs += [m.group(2) for m in _TEST_LOADER_RE.finditer(text)]
    found: set[str] = set()
    for spec in specs:
        module = resolve_repo_module(spec, rel)
        if module is None or not is_functions_module(module) or is_functions_pure_module(module):
            continue
        found.add(module)
    return [
        f"{rel}: imports {module} (only a pure Functions module may be imported outside functions/; paid calls stay in the Functions runtime)"
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


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_content(line: str) -> bool:
    stripped = line.strip()
    return stripped != "" and not stripped.startswith("#")


def workflow_sections(text: str) -> tuple[list[str], list[list[str]]]:
    """Top level (everything outside `jobs:`) and the jobs, at whatever indentation the first job uses (FA-F18-002).

    A job starts at the indentation of the first content line under `jobs:`. A deeper line stays in that job, so a
    four-space `web:` is one job and its eight-space `runs-on` is not a second job.
    """
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
    """Provider keys a workflow hands to a job that builds, starts or deploys the Next/eve service (spec R9a).

    The top level outside `jobs:` (workflow `env:`) reaches every job. A job is the block at the indentation of the
    first content line under `jobs:`, whether that is two spaces or four (FA-F18-002).
    """
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


def _npm_tool_root() -> pathlib.Path:
    """Directory with node_modules/typescript for the AST helper (repo root when the gate runs in a probe tree)."""
    for key in ("GITHUB_WORKSPACE", "SIKANDER_GATE_TOOL_ROOT", "WORKSPACE_ROOT"):
        env = os.environ.get(key)
        if env:
            root = pathlib.Path(env)
            if (root / "node_modules" / "typescript").is_dir():
                return root
    for root in (pathlib.Path.cwd(), *pathlib.Path.cwd().parents):
        if (root / "node_modules" / "typescript").is_dir():
            return root
    here = pathlib.Path(__file__).resolve().parent.parent
    return here


def agent_eve_model_ast_findings(scan_root: pathlib.Path) -> list[str]:
    """Rule (f) for JS/TS under agent/ via TypeScript AST (FA-F18-016)."""
    if os.environ.get("G0_STATIC_ONLY") == "1":
        return []
    agent_dir = scan_root / "agent"
    if not agent_dir.is_dir():
        return []
    tools = _npm_tool_root()
    script = tools / "ci_gates" / "check_agent_eve_model.ts"
    if not script.is_file():
        return ["agent/: missing ci_gates/check_agent_eve_model.ts (FA-F18-016)"]
    tsx_bin = tools / "node_modules" / ".bin" / "tsx"
    tsx_cmd = [str(tsx_bin)] if tsx_bin.is_file() else ["npx", "tsx"]
    try:
        proc = subprocess.run(
            [*tsx_cmd, str(script), str(scan_root.resolve())],
            cwd=str(tools),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return [f"agent/: could not run eve model AST check ({err})"]
    if proc.returncode == 0:
        return []
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if not lines:
        detail = (proc.stderr or proc.stdout or "unknown error").strip().replace("\n", " ")
        return [f"agent/: eve model AST check failed ({detail[:240]})"]
    return lines


def agent_text_model_findings(rel: str, text: str) -> list[str]:
    """Quoted or YAML-style model keys under agent/ (FA-F18-002, FA-F18-016 bypass 7)."""
    values: set[str] = set()
    for match in _AGENT_QUOTED_MODEL_RE.finditer(text):
        values.add(match.group(1))
    for match in _AGENT_MODEL_TEXT_RE.finditer(text):
        if match.group(1) != _COMMITTEE_BRAIN_MODEL:
            values.add(match.group(1))
    return [
        f"{rel}: gives eve the model string {value or '(empty)'}; eve's model is the P1 LanguageModel, never a Gateway model string"
        for value in sorted(values)
    ]


def agent_model_findings(rel: str, p: pathlib.Path) -> list[str]:
    """Rule (f): eve text config under agent/ (JS/TS handled by agent_eve_model_ast_findings)."""
    if not rel.startswith("agent/"):
        return []
    suffix = p.suffix.lower()
    kind = file_kind(p)
    if kind == "js" or suffix not in _AGENT_TEXT_SUFFIXES:
        return []
    text = read_text(p)
    if text is None:
        return []
    return agent_text_model_findings(rel, text)


def symlinked_dirs(root: pathlib.Path) -> list[str]:
    """Rule (g): every symlinked directory outside node_modules, .git and .next (FA-F18-002).

    The walk does not follow the link, so a directory planted under app/ would otherwise hide its files.
    """
    skip = frozenset({"node_modules", ".git", ".next"})
    out: list[str] = []
    for dirpath, dirnames, _filenames in os.walk(root):
        rel_dir = pathlib.Path(dirpath).relative_to(root)
        keep: list[str] = []
        for name in dirnames:
            if name in skip:
                continue
            if (pathlib.Path(dirpath) / name).is_symlink():
                rel = (rel_dir / name).as_posix()
                out.append(name if rel in {".", name} else rel[2:] if rel.startswith("./") else rel)
            else:
                keep.append(name)
        dirnames[:] = sorted(keep)
    return sorted(out)


def findings_for(p: pathlib.Path) -> list[str]:
    rel = rel_posix(p)
    if rel.startswith(FUNCTIONS_PREFIX):
        return []
    model = agent_model_findings(rel, p)
    text = read_text(p) if file_kind(p) == "js" else None
    paid = [] if text is None else functions_import_findings(rel, text)
    # corpus_service stays exempt from (a)-(d) (the F27 lane). Rule (e) still applies.
    if rel.startswith("corpus_service/"):
        return model + paid
    kind = deploy_kind(rel)
    if kind is not None:
        body = text if text is not None else read_text(p)
        deployed = [] if body is None else deploy_findings(rel, kind, body)
        return model + deployed
    if text is None:
        return model
    return model + paid + source_findings(rel, text)


def main(argv: list[str]) -> int:
    if "--print-key-names" in argv:
        print(json.dumps(list(PROVIDER_KEY_ENV_NAMES)))
        return 0
    if "--print-pure-modules" in argv:
        print(json.dumps(list(FUNCTIONS_PURE_MODULES)))
        return 0
    ast_only = "--rule-f-ast-only" in argv
    scan_root = pathlib.Path(".").resolve()
    if ast_only:
        failures = agent_eve_model_ast_findings(scan_root)
        if failures:
            print("FAIL: eve defineAgent model allowlist (audit F18 rule f, FA-F18-016):")
            for f in sorted(set(failures)):
                print(" ", f)
            return 1
        print("PASS: eve defineAgent model is the P1 LanguageModel import (rule f)")
        return 0
    failures: list[str] = [
        f"{d}: a symlinked directory; [19] does not follow links, so what is behind it would go unchecked"
        for d in symlinked_dirs(scan_root)
    ]
    failures.extend(agent_eve_model_ast_findings(scan_root))
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
