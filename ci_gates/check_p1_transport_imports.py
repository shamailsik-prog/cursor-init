#!/usr/bin/env python3
"""p1-transport-import guard (audit F34 R1-003, round 2 FA-F34-R2-001/-002/-004/-007; G-0 check [21]).

Every prompt the P1 path sends must come from a registered template (spec
docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, rulings R3, R17 and R29 to R36). A
call-site regex is bypassed by an ordinary alias, so this guard rules on how code reaches a transport: only the files
granted below may import a P1 transport, they may use it only in the narrow shapes listed under "Granted files", and no
file may reach the Gateway around the transports.

How it reads code (R31). Pure Python, because G-0 runs before `node_modules` exists: in CI ("Gates G-0, G-1, G-2"), the
step "Gate G-0 static" runs `G0_STATIC_ONLY=1 bash ci_gates/gate_g0.sh` before "Install", and the one TypeScript-compiler
check, F18 [19](f), runs as its own step after it. Each file is read as a token stream (ci_gates/js_lexer.py), never as
raw text: comments are dropped; identifiers and string literals are decoded as the engine reads them (`\\u0070`, `\\x74`,
`\\u{6f}`), so an escaped specifier or name is the name it spells; a quoted import name (`import { "activeTransport" as
at }`) is read as that name; and the text inside string, template and regular-expression literals is never read as code
(R36). Imports and exports are parsed from the tokens, across lines.

Restricted names (RESTRICTED): `functions/src/p1/transport`'s `activeTransport`, `gatewayTransport`, `P1Transport`,
`setP1TransportForTests` and `GATEWAY_URL`; `functions/src/p1/embeddingTransport`'s `activeEmbeddingTransport`,
`gatewayEmbeddingTransport`, `P1EmbeddingTransport`, `setP1EmbeddingTransportForTests` and `EMBEDDINGS_URL` (R32: the
URLs are granted to no file). Every other export (`modelId`, `plainId`, the error classes, the timeouts, the reply types)
stays importable.

Grants (GRANTS, R35: exactly the names each file imports): gateway.ts `activeTransport`; evalSet.ts the `P1Transport`
type; embedding.ts `activeEmbeddingTransport`; the operator CLI functions/src/cli/committeeEval.ts `gatewayTransport` and
`P1Transport`. A grant the file does not import fails, and so does a grant whose file is missing. The test seams are
granted to no source file. Send sites (SEND_SITES): gateway.ts, evalSet.ts, embedding.ts; any other granted file may hold
no `send` or `embed` token.

Scope: every JS/TS file the G-0 walker yields (g0_guard_common.iter_scan_files) except functions/test/ (the tests use the
seams) and functions/lib/ (build output).

It fails on:
  Anywhere in scope (R29, R30):
  - an import, re-export or load whose specifier resolves into a tree the scan does not read (UNSCANNED: functions/test/,
    functions/lib/, the root tests/, ci_gates/, _superseded/ and .eve/, and node_modules or .next by a path): a wrapper
    there would hand a transport on unseen;
  - a `#...` specifier (a package.json subpath import, which the gate cannot resolve);
  - outside a grant, a named import or an `export { } from` re-export of a restricted name (type-only included; `as`
    resolved to the original name);
  - granted files included (PR #129 review, Codex P2, thread 4368766679): a namespace or default import, `export *` and
    `export * as` of a transport module, and any `import()`, `require()`, `require.resolve()`, `import x = require()`,
    createRequire loader or vitest/jest importActual / requireActual / importMock / requireMock of one;
  - a grant whose file is missing, or a granted name the file does not import.
  Specifiers resolve as the bundler does (R29): relative; through the importer's nearest tsconfig.json (`paths`, then
  `baseUrl`, read from the file); the `@/` alias (functions/build.mjs: `@` is the repository root); a bare repository
  path; with or without a JS/TS extension or `/index`; a query or a hash stripped.
  Under functions/src, platform/ and services/ (COMPUTED_SCOPE; F18 [19] rules outside functions/):
  - an `import()`, `require()`, `require.resolve()`, createRequire loader or test loader whose specifier is not exactly
    one string literal (a variable, a call, a concatenation, a template literal with a substitution);
  - a module loader used other than as a direct call (`const r = require`, `require.cache`, a createRequire loader held
    or passed), or reached through a member (`module.require`, `x.require`, `module[...]`, `.mainModule`, `._load`)
    (R33);
  - code generated at run time: `eval`, `Function(...)`, `new Function`, `.constructor(...)`, the `vm` module (R33);
  - naming the AI Gateway key (`AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`) outside KEY_NAME_GRANTS, or the
    Gateway host (`ai-gateway.vercel.sh`) other than as a URL granted to that file in HOST_GRANTS, in an identifier, a
    string or template literal, or a `+` concatenation of literals (R32). A grant the file does not use fails.
  Granted files (R34: FA-F34-R2-002):
  - a restricted value name (`activeTransport` and the others, or an `as` alias of one) used other than as a direct call
    whose result is the initializer of a local `const` (`const t = activeTransport()`, `const t = c ? x() : null`): as
    a value, an argument, a property, a return value, under a getter, a class field or a cast, it fails;
  - that const, or a binding typed `P1Transport` / `P1EmbeddingTransport` (a parameter, `x: P1Transport | null`), used
    other than as the receiver of `.send(` / `.embed(`, an `.id` read, a `=== null` / `!== null` check, or an argument
    of `runLiveEvaluation(`: returned, stored, spread, passed elsewhere, read through a computed member, it fails;
  - an export of a restricted value or a value derived from one (`derived_exports`, kept from R17 and read across lines:
    `export { t }`, `export default t`, `export const t = ...`, `export =`, `module.exports`, an exported function that
    returns a restricted value);
  - a send or embed token, or a "send" / "embed" string, in a granted file that is not a send site.
A side-effect `import "…/transport"` binds nothing and passes.

`--print-grants` prints RESTRICTED, GRANTS, SEND_SITES, KEY_NAME_GRANTS and HOST_GRANTS as JSON
(tests/f34-p1-transport-import-gate.test.ts reads it).

Residual (spec residual 11, restated by R34): this is a lexer, not a type checker. A transport that reaches a granted
file under another type (a parameter typed `unknown`), a name shadowed in an inner scope, and code assembled from
anything but string literals (`["ai-gateway", "vercel", "sh"].join(".")`, a key held under another variable name, a
child process) are not traced. The grants are reviewed with this gate.
"""
from __future__ import annotations

import json
import pathlib
import posixpath
import re
import sys
from dataclasses import dataclass, field

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from g0_guard_common import JS_SUFFIXES, ROOT_ONLY_SKIP_DIRS, iter_scan_files, read_text  # noqa: E402
from js_lexer import Tok, lex  # noqa: E402

TRANSPORT = "functions/src/p1/transport"
EMBEDDING_TRANSPORT = "functions/src/p1/embeddingTransport"
# The send site that takes a transport as an argument (the eval CLI hands it the Gateway transport).
EVAL_SET = "functions/src/p1/evalSet"

RESTRICTED: dict[str, tuple[str, ...]] = {
    TRANSPORT: ("activeTransport", "gatewayTransport", "P1Transport", "setP1TransportForTests", "GATEWAY_URL"),
    EMBEDDING_TRANSPORT: ("activeEmbeddingTransport", "gatewayEmbeddingTransport", "P1EmbeddingTransport", "setP1EmbeddingTransportForTests", "EMBEDDINGS_URL"),
}
# The names that build or hand out a transport (or its seam). The two `P1...Transport` names are types; the URLs are
# strings, granted to no file.
VALUE_NAMES = frozenset({"activeTransport", "gatewayTransport", "setP1TransportForTests", "activeEmbeddingTransport", "gatewayEmbeddingTransport", "setP1EmbeddingTransportForTests"})
TYPE_NAMES = frozenset({"P1Transport", "P1EmbeddingTransport"})

GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    TRANSPORT: {
        "functions/src/p1/gateway.ts": ("activeTransport",),
        "functions/src/p1/evalSet.ts": ("P1Transport",),
        "functions/src/cli/committeeEval.ts": ("gatewayTransport", "P1Transport"),
    },
    EMBEDDING_TRANSPORT: {
        "functions/src/p1/embedding.ts": ("activeEmbeddingTransport",),
    },
}
# The granted files that send. Any other granted file may build or name a transport, never call it.
SEND_SITES = frozenset({"functions/src/p1/gateway.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/embedding.ts"})
GRANTED_FILES = frozenset(f for g in GRANTS.values() for f in g)

# R32: where the Gateway key may be named, and which Gateway URLs each file may name.
KEY_NAME_RE = re.compile(r"(?:VERCEL_)?AI_GATEWAY_API_KEY")
KEY_NAME_GRANTS = frozenset(
    {
        "functions/src/p1/transport.ts",  # activeTransport() reads the key
        "functions/src/p1/embeddingTransport.ts",  # activeEmbeddingTransport() reads the key
        "functions/src/cli/committeeEval.ts",  # the operator CLI reads the operator's key and says when it is unset
        "platform/p1/providerKeyGuard.ts",  # F18: the Next runtime's guard lists the names it refuses
    }
)
GATEWAY_HOST = "ai-gateway.vercel.sh"
_HOST_URL_RE = re.compile(r"(?:https?://)?ai-gateway\.vercel\.sh(?:[/?#][^\s\"'`<>)]*)?", re.I)
HOST_GRANTS: dict[str, tuple[str, ...]] = {
    "functions/src/p1/transport.ts": ("https://ai-gateway.vercel.sh/v1/chat/completions",),
    "functions/src/p1/embeddingTransport.ts": ("https://ai-gateway.vercel.sh/v1/embeddings",),
    # The source of the published prices (a `source:` string), never fetched.
    "functions/src/p1/costTable.ts": ("https://ai-gateway.vercel.sh/v1/models",),
}

EXCLUDED_PREFIXES = ("functions/test/", "functions/lib/")
COMPUTED_SCOPE = ("functions/src/", "platform/", "services/")
# R30: trees the G-0 walker does not read (g0_guard_common: ROOT_ONLY_SKIP_DIRS at the root, node_modules and .next at
# any depth) and the two this guard skips. An import into one of them from a scanned file would hand on what it pleases.
UNSCANNED_PREFIXES = tuple(sorted({*EXCLUDED_PREFIXES, *(f"{d}/" for d in ROOT_ONLY_SKIP_DIRS)}))
_UNSCANNED_SEGMENTS = ("node_modules", ".next")

_JS_EXT_RE = re.compile(r"\.(?:d\.)?(?:[cm]?[jt]sx?)$", re.I)
_RESOLVE_EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json")
_TEST_LOADERS = frozenset({"importActual", "requireActual", "importMock", "requireMock"})
_ASSIGN_OPS = frozenset("= += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=".split())
_EQUALITY = frozenset({"===", "!==", "==", "!="})
# A line break before one of these does not end a statement (no automatic semicolon insertion).
_CONTINUE_PUNCT = frozenset(
    ". ?. ( [ => ? : + - * / % ** == === != !== < > <= >= && || ?? & | ^ << >> >>> , = += -= *= /= %= **= <<= >>= >>>= &= |= ^= &&= ||= ??=".split()
)
_CONTINUE_WORDS = frozenset({"as", "satisfies", "in", "instanceof"})
# After one of these the expression goes on, whatever follows on the next line.
_OPERATOR_WORDS = frozenset({"typeof", "new", "delete", "void", "await", "in", "instanceof", "as", "satisfies", "of", "keyof", "extends"})
# Tokens that may stand between a const's `=` and a restricted call (a ternary's condition and branch).
_CONDITION_PUNCT = frozenset({".", "?.", "!", "===", "!==", "==", "!=", "<", ">", "<=", ">=", "&&", "||", "??", "?", ":"})
_CONDITION_WORDS_BANNED = frozenset({"function", "class", "return", "yield", "await", "new", "delete", "void", "as", "satisfies", "import", "require", "async", "get", "set", "static"})
_NULLISH = frozenset({"null", "undefined"})

_COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.DOTALL)


def strip_comments(text: str) -> str:
    """The text with `//` and `/* */` comments blanked (newlines kept), outside '...', "..." and `...` literals. Used to
    read tsconfig.json (JSON with comments)."""
    out: list[str] = []
    i, n = 0, len(text)
    quote: str | None = None
    while i < n:
        c = text[i]
        if quote is not None:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"`":
            quote = c
            out.append(c)
            i += 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(ch if ch == "\n" else " " for ch in text[i:j]))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------------------------------------------------
# Resolution (R29)
# ---------------------------------------------------------------------------------------------------------------------


@dataclass
class TsConfig:
    """What resolution needs from one tsconfig.json: the directory `paths` resolve against and the `paths` table, and the
    `baseUrl` directory (None when unset). Paths are repository-relative POSIX."""

    paths_base: str
    paths: dict[str, list[str]]
    base_url: str | None


def _jsonc(text: str) -> dict:
    body = re.sub(r",(\s*[}\]])", r"\1", strip_comments(text))
    data = json.loads(body)
    return data if isinstance(data, dict) else {}


class Resolver:
    """Resolves a specifier as the Functions bundle does (esbuild with `alias: {"@": repoRoot}`, reading the nearest
    tsconfig.json of each importer for `paths` and `baseUrl`)."""

    def __init__(self, root: pathlib.Path):
        self.root = root
        self._configs: dict[str, TsConfig | None] = {}

    def _exists(self, path: str) -> bool:
        p = self.root / path
        if p.is_file():
            return True
        stem = _JS_EXT_RE.sub("", path)
        for ext in _RESOLVE_EXTS:
            if (self.root / (stem + ext)).is_file() or (self.root / stem / ("index" + ext)).is_file():
                return True
        return False

    def _load(self, rel_config: str, depth: int = 0) -> TsConfig | None:
        try:
            data = _jsonc((self.root / rel_config).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        here = posixpath.dirname(rel_config)
        base: TsConfig | None = None
        ext = data.get("extends")
        if isinstance(ext, str) and ext.startswith(".") and depth < 8:
            target = posixpath.normpath(posixpath.join(here, ext))
            if not target.endswith(".json"):
                target += ".json"
            base = self._load(target, depth + 1)
        opts = data.get("compilerOptions") if isinstance(data.get("compilerOptions"), dict) else {}
        base_url = base.base_url if base else None
        if isinstance(opts.get("baseUrl"), str):
            base_url = posixpath.normpath(posixpath.join(here, opts["baseUrl"]))
        paths = base.paths if base else {}
        paths_base = base.paths_base if base else here
        if isinstance(opts.get("paths"), dict):
            paths = {k: [v for v in vs if isinstance(v, str)] for k, vs in opts["paths"].items() if isinstance(k, str) and isinstance(vs, list)}
            paths_base = base_url if base_url is not None else here
        elif base_url is not None and isinstance(opts.get("baseUrl"), str):
            paths_base = base_url
        return TsConfig(paths_base=paths_base, paths=paths, base_url=base_url)

    def config_for(self, importer: str) -> TsConfig | None:
        d = posixpath.dirname(importer)
        chain: list[str] = []
        found: TsConfig | None = None
        while True:
            if d in self._configs:
                found = self._configs[d]
                break
            chain.append(d)
            candidate = posixpath.join(d, "tsconfig.json") if d else "tsconfig.json"
            if (self.root / candidate).is_file():
                found = self._load(candidate)
                break
            if not d:
                break
            d = posixpath.dirname(d)
        for c in chain:
            self._configs[c] = found
        return found

    def resolve(self, spec: str, importer: str) -> str | None:
        """The repository module (extension and `/index` removed) a literal specifier names, or None for a package, a
        URL, a `#` subpath or a path that leaves the repository."""
        raw = spec.strip().split("?", 1)[0].split("#", 1)[0].strip()
        if not raw or ":" in raw.split("/", 1)[0] or raw.startswith("/"):
            return None
        path: str | None = None
        if raw.startswith(("./", "../")) or raw in {".", ".."}:
            path = posixpath.join(posixpath.dirname(importer), raw)
        else:
            cfg = self.config_for(importer)
            if cfg is not None:
                path = self._through_paths(raw, cfg)
                if path is None and cfg.base_url is not None:
                    candidate = posixpath.normpath(posixpath.join(cfg.base_url, raw))
                    if self._exists(candidate):
                        path = candidate
            if path is None:
                path = raw[2:] if raw.startswith("@/") else raw
        path = posixpath.normpath(_module_id(posixpath.normpath(path)))
        return None if path == ".." or path.startswith("../") else path

    def _through_paths(self, raw: str, cfg: TsConfig) -> str | None:
        first: str | None = None
        # The longest prefix wins, as in TypeScript.
        for pattern in sorted(cfg.paths, key=lambda p: len(p.split("*", 1)[0]), reverse=True):
            star = pattern.find("*")
            if star < 0:
                if raw != pattern:
                    continue
                captured = ""
            else:
                prefix, suffix = pattern[:star], pattern[star + 1 :]
                if not (raw.startswith(prefix) and raw.endswith(suffix) and len(raw) >= len(prefix) + len(suffix)):
                    continue
                captured = raw[len(prefix) : len(raw) - len(suffix)]
            for target in cfg.paths[pattern]:
                candidate = posixpath.normpath(posixpath.join(cfg.paths_base, target.replace("*", captured, 1)))
                if self._exists(candidate):
                    return candidate
                if first is None:
                    first = candidate
            if first is not None:
                return first
        return first


def _module_id(path: str) -> str:
    p = _JS_EXT_RE.sub("", path)
    return p[: -len("/index")] if p.endswith("/index") else ("" if p == "index" else p)


def _unscanned(module: str) -> bool:
    return module.startswith(UNSCANNED_PREFIXES) or any(seg in _UNSCANNED_SEGMENTS for seg in module.split("/"))


# ---------------------------------------------------------------------------------------------------------------------
# Token structure
# ---------------------------------------------------------------------------------------------------------------------


@dataclass
class Code:
    """A file's tokens and their bracket structure: `close[i]` for an opener, `open[i]` for a closer, `parent[i]` the
    innermost opener enclosing token i (-1 at the top). A template's `${` opens and its `}` closes, like a bracket."""

    toks: list[Tok]
    close: dict[int, int] = field(default_factory=dict)
    open: dict[int, int] = field(default_factory=dict)
    parent: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        stack: list[int] = []
        self.parent = [-1] * len(self.toks)
        for i, t in enumerate(self.toks):
            closes = (t.kind == "punct" and t.value in ")]}") or (t.kind == "tpl" and t.part in ("middle", "tail"))
            opens = (t.kind == "punct" and t.value in "([{") or (t.kind == "tpl" and t.part in ("head", "middle"))
            if closes and stack:
                j = stack.pop()
                self.close[j] = i
                self.open[i] = j
            self.parent[i] = stack[-1] if stack else -1
            if opens:
                stack.append(i)

    def at(self, i: int) -> Tok | None:
        return self.toks[i] if 0 <= i < len(self.toks) else None

    def punct(self, i: int, *values: str) -> bool:
        t = self.at(i)
        return t is not None and t.kind == "punct" and t.value in values

    def word(self, i: int, *values: str) -> bool:
        t = self.at(i)
        return t is not None and t.kind == "id" and t.value in values

    def ident(self, i: int) -> bool:
        t = self.at(i)
        return t is not None and t.kind == "id"

    def member(self, i: int) -> bool:
        """Token i follows `.` or `?.`: a property name, not a binding."""
        return self.punct(i - 1, ".", "?.")

    def free(self, i: int) -> bool:
        """Token i is an identifier read as a binding: not a property after `.`, not an object or type-literal key."""
        if not self.ident(i) or self.member(i):
            return False
        return not self.key(i)

    def key(self, i: int) -> bool:
        """Token i is a key in an object or type literal (`{ k: v }`, `, k: v`, `; k: T`, `k?: T`, or a member on its own
        line after the end of the one before it), not a reference. A ternary branch (`c ?\n  k\n  : v`) is not a key: the
        token before it is an operator."""
        if not (self.punct(i + 1, ":") or (self.punct(i + 1, "?") and self.punct(i + 2, ":"))):
            return False
        if self.punct(i - 1, "{", ",", ";"):
            return True
        t, p = self.at(i), self.at(i - 1)
        if t is None or p is None or not t.nl:
            return False
        opener = self.parent[i]
        if opener < 0 or not self.punct(opener, "{"):
            return False
        return p.kind in ("id", "str", "num") or (p.kind == "punct" and p.value in (")", "]", "}", ">"))

    def end_of_group(self, i: int) -> int:
        """The index just after the bracket group (or whole template) opened at i."""
        j = i
        while j in self.close:
            j = self.close[j]
            t = self.toks[j]
            if not (t.kind == "tpl" and t.part == "middle"):
                break
        return j + 1

    def asi(self, j: int) -> bool:
        """A line break before token j ends the statement (automatic semicolon insertion)."""
        t, p = self.at(j), self.at(j - 1)
        if t is None or p is None or not t.nl:
            return False
        if t.kind == "punct" and t.value in _CONTINUE_PUNCT:
            return False
        if t.kind == "id" and t.value in _CONTINUE_WORDS:
            return False
        if t.kind == "tpl" and t.part in ("full", "head"):
            return False
        if p.kind == "punct" and p.value not in (")", "]", "}", "++", "--"):
            return False
        if p.kind == "id" and p.value in _OPERATOR_WORDS:
            return False
        return True

    def stmt_end(self, start: int) -> int:
        """The index just after the statement or expression starting at `start`: a `;`, a line break that ends it, a
        depth-0 `,` (when `stop_at_comma`), or the closer of the group it sits in."""
        return self._scan_end(start, stop_at_comma=False)

    def item_end(self, start: int) -> int:
        return self._scan_end(start, stop_at_comma=True)

    def _scan_end(self, start: int, stop_at_comma: bool) -> int:
        j, n = start, len(self.toks)
        while j < n:
            t = self.toks[j]
            if j > start and self.asi(j):
                return j
            if t.kind == "punct" and (t.value == ";" or (stop_at_comma and t.value == ",")):
                return j
            if j in self.open:
                return j
            if j in self.close:
                j = self.end_of_group(j)
                continue
            j += 1
        return n

    def stmt_start(self, i: int) -> bool:
        if i == 0:
            return True
        t = self.toks[i]
        return t.nl or self.punct(i - 1, ";", "{", "}")


# ---------------------------------------------------------------------------------------------------------------------
# Imports, exports and loads
# ---------------------------------------------------------------------------------------------------------------------


@dataclass
class Ref:
    """One module reference. kind: import, export-from, side-effect, load (import(), require(), a test or createRequire
    loader), computed (a load whose specifier is not one literal). names: (original, local) pairs of a named clause.
    whole: the locals of a default or namespace binding, or "*" for `export *`."""

    kind: str
    spec: str | None
    names: list[tuple[str, str | None]]
    whole: list[str]
    start: int
    end: int


def _attributes_end(c: Code, j: int) -> int:
    """Skips `with { ... }` / `assert { ... }` import attributes after a specifier."""
    if c.word(j, "with", "assert") and c.punct(j + 1, "{") and not c.at(j).nl:
        return c.end_of_group(j + 1)
    return j


def _named_clause(c: Code, j: int, exported: bool) -> tuple[list[tuple[str, str | None]], int] | None:
    """`{ a, type b, "c" as d, e as "f" }` at c.toks[j] == `{`: the (original, local) pairs and the index after `}`."""
    out: list[tuple[str, str | None]] = []
    k = j + 1
    while True:
        u = c.at(k)
        if u is None:
            return None
        if u.kind == "punct" and u.value == "}":
            return out, k + 1
        if u.kind == "id" and u.value == "type" and c.at(k + 1) is not None and c.at(k + 1).kind in ("id", "str") and not c.word(k + 1, "as") and not c.punct(k + 1, ",", "}"):
            k += 1
            u = c.toks[k]
        elif u.kind == "id" and u.value == "type" and c.word(k + 1, "as") and c.at(k + 2) is not None and c.at(k + 2).kind in ("id", "str") and c.word(k + 3, "as"):
            k += 1  # `type as as x`: a type-only import of `as`
            u = c.toks[k]
        if u.kind not in ("id", "str"):
            return None
        original = u.value
        local: str | None = u.value if u.kind == "id" else None
        k += 1
        if c.word(k, "as"):
            v = c.at(k + 1)
            if v is None or v.kind not in ("id", "str"):
                return None
            local = v.value if (v.kind == "id" or exported) else None
            k += 2
        out.append((original, local))
        if c.punct(k, ","):
            k += 1
            continue
        if c.punct(k, "}"):
            return out, k + 1
        return None


def _parse_import(c: Code, i: int) -> Ref | None:
    """A static import at c.toks[i] == `import` (not `import(` or `import.meta`), or None when the tokens are not one."""
    j = i + 1
    t = c.at(j)
    if t is None:
        return None
    if t.kind == "str":
        return Ref("side-effect", t.value, [], [], i, _attributes_end(c, j + 1))
    if c.word(j, "type") and not c.word(j + 1, "from") and not c.punct(j + 1, ",", "="):
        j += 1
        t = c.at(j)
    if t is not None and t.kind == "id" and c.punct(j + 1, "="):
        # `import x = require("...")` (read as a load by the loader scan) or `import x = A.B` (a namespace alias).
        return Ref("import-equals", None, [], [t.value], i, j + 2)
    names: list[tuple[str, str | None]] = []
    whole: list[str] = []
    clause = False
    if c.ident(j) and not (c.word(j, "from") and c.at(j + 1) is not None and c.at(j + 1).kind == "str"):
        whole.append(c.toks[j].value)
        clause = True
        j += 1
        if c.punct(j, ","):
            j += 1
    if c.punct(j, "*"):
        if not (c.word(j + 1, "as") and c.ident(j + 2)):
            return None
        whole.append(c.toks[j + 2].value)
        clause = True
        j += 3
    elif c.punct(j, "{"):
        parsed = _named_clause(c, j, exported=False)
        if parsed is None:
            return None
        names, j = parsed
        clause = True
    if not clause or not c.word(j, "from") or c.at(j + 1) is None or c.at(j + 1).kind != "str":
        return None
    return Ref("import", c.toks[j + 1].value, names, whole, i, _attributes_end(c, j + 2))


def _parse_export(c: Code, i: int) -> Ref | None:
    """`export * [as x] from`, `export [type] { ... } [from]` at c.toks[i] == `export`; None for every other export."""
    j = i + 1
    if c.word(j, "type") and c.punct(j + 1, "{", "*"):
        j += 1
    if c.punct(j, "*"):
        j += 1
        if c.word(j, "as") and c.at(j + 1) is not None and c.at(j + 1).kind in ("id", "str"):
            j += 2
        if c.word(j, "from") and c.at(j + 1) is not None and c.at(j + 1).kind == "str":
            return Ref("export-from", c.toks[j + 1].value, [], ["*"], i, _attributes_end(c, j + 2))
        return None
    if c.punct(j, "{"):
        parsed = _named_clause(c, j, exported=True)
        if parsed is None:
            return None
        names, j = parsed
        if c.word(j, "from") and c.at(j + 1) is not None and c.at(j + 1).kind == "str":
            return Ref("export-from", c.toks[j + 1].value, names, [], i, _attributes_end(c, j + 2))
        return Ref("export-list", None, names, [], i, j)
    return None


def _literal_arg(c: Code, a: int) -> tuple[str | None, bool]:
    """The specifier a loader call's argument list (starting at token a, just after `(`) names: (literal, computed)."""
    t = c.at(a)
    if t is None:
        return None, True
    if t.kind == "punct" and t.value == ")":
        return None, False
    if t.kind == "str" or (t.kind == "tpl" and t.part == "full"):
        if c.punct(a + 1, ")", ","):
            return t.value, False
    return None, True


def _skip_type_args(c: Code, j: int) -> int:
    """The index after `<...>` type arguments at token j (`>>` and `>>>` close two and three)."""
    if not c.punct(j, "<"):
        return j
    depth = 0
    while j < len(c.toks):
        t = c.toks[j]
        if t.kind == "punct":
            if t.value == "<":
                depth += 1
            elif t.value in (">", ">>", ">>>"):
                depth -= len(t.value)
                if depth <= 0:
                    return j + 1
            elif t.value in ("(", ")", ";", "{", "}"):
                return j
        j += 1
    return j


@dataclass
class Reading:
    """What one file's tokens say: its module references, the token ranges of its import statements, and the findings
    of the loader rules (R33) for COMPUTED_SCOPE."""

    refs: list[Ref]
    import_spans: list[tuple[int, int]]
    loader_findings: list[str]
    unreadable: list[int]


def read_refs(c: Code, rel: str) -> Reading:
    refs: list[Ref] = []
    spans: list[tuple[int, int]] = []
    findings: list[str] = []
    unreadable: list[int] = []
    toks = c.toks
    # createRequire factories (with their `as` aliases from node:module) and the loaders bound to their results.
    factories = {"createRequire"}
    for i, t in enumerate(toks):
        if t.kind != "id" or c.member(i) or c.key(i):
            continue
        if t.value == "import" and not c.punct(i + 1, "(", ".") and c.stmt_start(i):
            ref = _parse_import(c, i)
            if ref is None:
                unreadable.append(i)
                continue
            if ref.kind != "import-equals":
                refs.append(ref)
            spans.append((ref.start, ref.end))
            if ref.spec in ("module", "node:module"):
                factories.update(local for original, local in ref.names if original == "createRequire" and local)
        elif t.value == "export" and c.stmt_start(i):
            ref = _parse_export(c, i)
            if ref is not None:
                refs.append(ref)
                if ref.kind == "export-from":
                    spans.append((ref.start, ref.end))
    loaders = {"require"}
    for i, t in enumerate(toks):
        if t.kind != "id":
            continue
        is_factory = t.value in factories and (not c.member(i) or t.value == "createRequire")
        if is_factory and c.punct(i + 1, "(") and not c.key(i):
            k = c.close.get(i + 1)
            if k is not None and c.punct(k + 1, "("):
                spec, computed = _literal_arg(c, k + 2)
                refs.append(Ref("computed" if computed else "load", spec, [], [], i, k + 2))
            # `r = createRequire(...)` or `r = module.createRequire(...)`
            j = i - 1
            if c.member(i):
                j = i - 3
            if c.punct(j, "=") and c.ident(j - 1):
                loaders.add(toks[j - 1].value)
    for i, t in enumerate(toks):
        if t.kind != "id":
            continue
        name = t.value
        if c.member(i):
            if name in ("require", "mainModule", "_load") and rel.startswith(COMPUTED_SCOPE):
                findings.append(f"{rel}: reaches a module loader through a member (.{name})")
            if name == "constructor" and c.punct(i + 1, "(") and rel.startswith(COMPUTED_SCOPE):
                findings.append(f"{rel}: generates code at run time (.constructor(...))")
            if name in _TEST_LOADERS and c.word(i - 2, "vi", "jest") and not c.member(i - 2):
                a = _skip_type_args(c, i + 1)
                if c.punct(a, "("):
                    spec, computed = _literal_arg(c, a + 1)
                    refs.append(Ref("computed" if computed else "load", spec, [], [], i, a + 1))
            continue
        if c.key(i):
            continue
        if name == "import" and c.punct(i + 1, "("):
            spec, computed = _literal_arg(c, i + 2)
            refs.append(Ref("computed" if computed else "load", spec, [], [], i, i + 2))
        elif name in loaders:
            if c.punct(i + 1, "("):
                spec, computed = _literal_arg(c, i + 2)
                refs.append(Ref("computed" if computed else "load", spec, [], [], i, i + 2))
            elif c.punct(i + 1, ".") and c.word(i + 2, "resolve") and c.punct(i + 3, "("):
                spec, computed = _literal_arg(c, i + 4)
                refs.append(Ref("computed" if computed else "load", spec, [], [], i, i + 4))
            elif name == "require" and c.punct(i + 1, ".") and c.word(i + 2, "main"):
                pass  # `require.main === module`: no load
            elif _is_binding(c, i):
                pass  # `const r = createRequire(...)`: the binding itself
            elif rel.startswith(COMPUTED_SCOPE):
                findings.append(f"{rel}: uses {name} other than as a direct call (a module loader held, passed or read)")
        elif name in factories and name not in loaders and not c.punct(i + 1, "(") and not _in_spans(i, spans) and rel.startswith(COMPUTED_SCOPE):
            findings.append(f"{rel}: uses {name} other than as a direct call (a module loader held, passed or read)")
        elif name == "module" and c.punct(i + 1, "[", "?.") and rel.startswith(COMPUTED_SCOPE):
            if c.punct(i + 1, "[") or c.punct(i + 2, "["):
                findings.append(f"{rel}: reaches a module loader through a member (a computed member of module)")
        elif name == "module" and rel.startswith(COMPUTED_SCOPE) and not _module_read_ok(c, i):
            findings.append(f"{rel}: reaches a module loader through a member (module used as a value: only module.exports, module.id and `=== module` are read)")
        elif name == "eval" and rel.startswith(COMPUTED_SCOPE):
            findings.append(f"{rel}: generates code at run time (eval)")
        elif name == "Function" and (c.punct(i + 1, "(") or c.word(i - 1, "new")) and rel.startswith(COMPUTED_SCOPE):
            findings.append(f"{rel}: generates code at run time (Function)")
    return Reading(refs, spans, findings, unreadable)


def _module_read_ok(c: Code, i: int) -> bool:
    """Token i (a free `module`) is `module.exports`, `module.id`, an equality operand (`require.main === module`), or the
    TypeScript `declare module "x"` / `module Name {` form; any other read hands on `module.require`."""
    if c.punct(i + 1, ".") and c.word(i + 2, "exports", "id"):
        return True
    if c.punct(i + 1, *_EQUALITY) or c.punct(i - 1, *_EQUALITY):
        return True
    nxt = c.at(i + 1)
    return c.word(i - 1, "declare") or (nxt is not None and nxt.kind in ("str", "id") and not nxt.nl)


def _is_binding(c: Code, i: int) -> bool:
    """Token i is the name a `const`/`let`/`var` declares (`const r = ...`)."""
    return c.word(i - 1, "const", "let", "var") and c.punct(i + 1, "=", ":")


def _in_spans(i: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= i < b for a, b in spans)


# ---------------------------------------------------------------------------------------------------------------------
# Granted files (R34) and derived exports
# ---------------------------------------------------------------------------------------------------------------------


@dataclass
class Decl:
    """One `const`/`let`/`var` declarator: its kind, the names it binds, the token range of its initializer, whether the
    statement is exported, and the index of its (first) name."""

    kind: str
    names: list[str]
    init: tuple[int, int]
    exported: bool
    name_at: int


def declarations(c: Code) -> list[Decl]:
    out: list[Decl] = []
    toks = c.toks
    for i, t in enumerate(toks):
        if not (t.kind == "id" and t.value in ("const", "let", "var")) or c.member(i) or c.key(i):
            continue
        exported = c.word(i - 1, "export") and c.stmt_start(i - 1)
        if not exported and not c.stmt_start(i) and not c.punct(i - 1, "("):
            continue
        j = i + 1
        while True:
            name_at = j
            names: list[str] = []
            if c.ident(j) and not c.word(j, "of", "in"):
                names = [toks[j].value]
                j += 1
            elif c.punct(j, "{", "["):
                end = c.end_of_group(j)
                names = [toks[k].value for k in range(j + 1, end - 1) if c.ident(k) and not c.member(k) and not c.punct(k + 1, ":", "(")]
                j = end
            else:
                break
            if c.punct(j, ":"):
                j = _type_end(c, j + 1)
            if not c.punct(j, "="):
                end = c.item_end(j)
                out.append(Decl(t.value, names, (j, j), exported, name_at))
            else:
                end = c.item_end(j + 1)
                out.append(Decl(t.value, names, (j + 1, end), exported, name_at))
            if c.punct(end, ","):
                j = end + 1
                continue
            break
    return out


def _type_end(c: Code, j: int) -> int:
    """The index after a type annotation starting at token j (up to a depth-0 `=`, `,`, `)`, `;` or statement end)."""
    n = len(c.toks)
    start = j
    while j < n:
        t = c.toks[j]
        if j > start and c.asi(j):
            return j
        if t.kind == "punct" and t.value in ("=", ",", ";", ")", "]", "}"):
            return j
        if j in c.close:
            j = c.end_of_group(j)
            continue
        if t.kind == "punct" and t.value == "<":
            j = _skip_type_args(c, j)
            continue
        j += 1
    return n


def _mentions(c: Code, a: int, b: int, names: set[str]) -> str | None:
    """The first of `names` read as a binding between tokens a and b (not a property, not a key), or None."""
    for k in range(a, b):
        t = c.toks[k]
        if t.kind == "id" and t.value in names and c.free(k):
            return t.value
    return None


def _functions(c: Code) -> list[tuple[str, int, int, bool]]:
    """Each `function NAME (...) { body }` declaration: name, body token range, and whether it is exported."""
    out: list[tuple[str, int, int, bool]] = []
    for i, t in enumerate(c.toks):
        if not (t.kind == "id" and t.value == "function") or c.member(i):
            continue
        j = i + 1
        if c.punct(j, "*"):
            j += 1
        if not c.ident(j):
            continue
        name = c.toks[j].value
        if not c.punct(j + 1, "(") and not c.punct(j + 1, "<"):
            continue
        k = _skip_type_args(c, j + 1)
        if not c.punct(k, "("):
            continue
        k = c.end_of_group(k)
        if c.punct(k, ":"):
            while k < len(c.toks) and not c.punct(k, "{"):
                k = c.end_of_group(k) if k in c.close else k + 1
        if not c.punct(k, "{"):
            continue
        body_end = c.close.get(k, len(c.toks))
        s = i - 1
        while c.word(s, "async", "default"):
            s -= 1
        out.append((name, k + 1, body_end, c.word(s, "export")))
    return out


def derived_exports(c: Code, bound: set[str]) -> list[tuple[str, str]]:
    """The exported names that hold a restricted transport value or a value derived from one (PR #129 review, Codex P2,
    thread 4368766681), read across lines from the tokens: a `const`/`let`/`var` whose initializer reads a tainted name
    is tainted, to a fixpoint; then `export { x }`, `export default x`, `export const y = <tainted>`, `export =`,
    `module.exports` / `exports.x =` of a tainted name, and an exported function whose body returns a restricted value,
    fail. Returns (name, how) pairs; how is "value" or "function"."""
    tainted = set(bound)
    decls = declarations(c)
    changed = True
    while changed:
        changed = False
        for d in decls:
            if any(n not in tainted for n in d.names) and _mentions(c, d.init[0], d.init[1], tainted):
                tainted.update(d.names)
                changed = True
    out: set[tuple[str, str]] = set()
    toks = c.toks
    for d in decls:
        if d.exported and _mentions(c, d.init[0], d.init[1], tainted):
            out.update((n, "value") for n in d.names)
    for i, t in enumerate(toks):
        if t.kind != "id" or c.member(i):
            continue
        if t.value == "export" and c.stmt_start(i):
            if c.punct(i + 1, "{"):
                parsed = _named_clause(c, i + 1, exported=True)
                if parsed is not None and not c.word(parsed[1], "from"):
                    out.update((orig, "value") for orig, _ in parsed[0] if orig in tainted)
            elif c.word(i + 1, "default") and not c.word(i + 2, "function", "class", "async"):
                end = c.stmt_end(i + 2)
                hit = _mentions(c, i + 2, end, tainted)
                if hit:
                    out.add((hit, "value"))
            elif c.punct(i + 1, "="):
                hit = _mentions(c, i + 2, c.stmt_end(i + 2), tainted)
                if hit:
                    out.add((hit, "value"))
        elif (t.value == "module" and c.punct(i + 1, ".") and c.word(i + 2, "exports")) or (t.value == "exports" and c.punct(i + 1, ".")):
            j = i + 3 if t.value == "module" else i + 1
            while c.punct(j, ".") and c.ident(j + 1):
                j += 2
            if c.punct(j, "["):
                j = c.end_of_group(j)
            if c.punct(j, "="):
                hit = _mentions(c, j + 1, c.stmt_end(j + 1), tainted)
                if hit:
                    out.add((hit, "value"))
    restricted = set(bound) | VALUE_NAMES
    for name, a, b, exported in _functions(c):
        if not exported:
            continue
        for k in range(a, b):
            if c.word(k, "return") and not c.member(k):
                if _mentions(c, k + 1, c.stmt_end(k + 1), restricted):
                    out.add((name, "function"))
                    break
    return sorted(out)


def _const_holding(c: Code, i: int) -> int | None:
    """When token i (a restricted value name) is a direct call whose result initializes a local `const` - alone or as a
    ternary branch - the index of that const's name; else None."""
    if not c.punct(i + 1, "("):
        return None
    k = c.close.get(i + 1)
    if k is None:
        return None
    after = c.at(k + 1)
    if not (after is None or c.punct(k + 1, ";", ":", "}") or c.asi(k + 1)):
        return None
    if not c.punct(i - 1, "=", "?", ":"):
        return None
    j = i - 1
    while j >= 0:
        t = c.toks[j]
        if j in c.open:  # a closer: step over its group
            j = c.open[j] - 1
            continue
        if j in c.close:  # an opener that encloses i: the call is nested
            return None
        if t.kind == "punct" and t.value == "=":
            n = j - 1
            if not (c.ident(n) and c.word(n - 1, "const")):
                # `const t: P1Transport | null = ...`: step back over the annotation to its `:`
                m = n
                while m >= 0 and not c.punct(m, ":", ";", "=", "{", "}", "(", ")"):
                    m -= 1
                if not c.punct(m, ":"):
                    return None
                n = m - 1
            if c.ident(n) and c.word(n - 1, "const") and not c.member(n - 1) and c.stmt_start(n - 1) and not c.word(n - 2, "export", "declare"):
                return n
            return None
        if t.kind == "punct" and t.value not in _CONDITION_PUNCT:
            return None
        if t.kind == "id" and t.value in _CONDITION_WORDS_BANNED:
            return None
        if t.kind == "tpl" and t.part != "full":
            return None
        j -= 1
    return None


def _typed_bindings(c: Code) -> dict[int, str]:
    """Bindings typed as a transport: `name: P1Transport`, `name?: P1Transport | null` (parameters, declarations), and a
    declaration whose annotation or initializer names a transport type (`const t = x as P1Transport`). Index of the name
    token -> name."""
    out: dict[int, str] = {}
    toks = c.toks
    for i, t in enumerate(toks):
        if t.kind != "id" or c.member(i):
            continue
        j = i + 1
        if c.punct(j, "?"):
            j += 1
        if not c.punct(j, ":"):
            continue
        end = _type_end(c, j + 1)
        words = [toks[k] for k in range(j + 1, end)]
        if words and all((w.kind == "id" and (w.value in TYPE_NAMES or w.value in _NULLISH or w.value == "readonly")) or (w.kind == "punct" and w.value == "|") for w in words):
            if any(w.kind == "id" and w.value in TYPE_NAMES for w in words):
                out[i] = t.value
    for d in declarations(c):
        if len(d.names) != 1:
            continue
        lo = d.name_at + 1
        if _mentions_type(c, lo, d.init[1]):
            out[d.name_at] = d.names[0]
    return out


def _mentions_type(c: Code, a: int, b: int) -> bool:
    return any(c.toks[k].kind == "id" and c.toks[k].value in TYPE_NAMES and not c.member(k) for k in range(a, b))


def _transport_use_ok(c: Code, i: int, live_eval: set[str]) -> bool:
    """Token i (a transport binding read) is the receiver of `.send(` / `.embed(`, an `.id` read, a null check, or an
    argument of `runLiveEvaluation(` as imported from evalSet.ts (`live_eval`: its local names in this file), never of a
    function a granted file defines under that name."""
    k = i + 1
    if c.punct(k, "!"):
        k += 1
    if c.punct(k, ".", "?."):
        if c.word(k + 1, "send", "embed") and c.punct(k + 2, "("):
            return True
        if c.word(k + 1, "id"):
            nxt = c.at(k + 2)
            return not (nxt is not None and nxt.kind == "punct" and (nxt.value in _ASSIGN_OPS or nxt.value in ("(", "++", "--", ".", "?.", "[")))
        return False
    if c.punct(i + 1, *_EQUALITY) and c.word(i + 2, *_NULLISH):
        return True
    if c.punct(i - 1, *_EQUALITY) and c.word(i - 2, *_NULLISH):
        return True
    if c.punct(i - 1, "(", ",") and c.punct(i + 1, ",", ")"):
        p = c.parent[i]
        if p >= 0 and c.punct(p, "(") and live_eval and c.word(p - 1, *live_eval) and not c.member(p - 1):
            return True
    return False


def granted_findings(c: Code, rel: str, value_locals: dict[str, str], whole_locals: set[str], spans: list[tuple[int, int]], live_eval: set[str]) -> list[str]:
    """R34 for a granted file. `value_locals`: local name -> restricted value name, from this file's imports;
    `live_eval`: the local names of evalSet.ts's `runLiveEvaluation` this file imports."""
    out: list[str] = []
    restricted = set(value_locals) | VALUE_NAMES
    tracked: dict[int, str] = {}  # binding token index -> name
    for i, t in enumerate(c.toks):
        if t.kind != "id" or t.value not in restricted or not c.free(i) or _in_spans(i, spans):
            continue
        held = _const_holding(c, i)
        if held is None:
            out.append(f"{rel}: uses {t.value} other than as a direct call held in a local const")
        else:
            tracked[held] = c.toks[held].value
    tracked.update(_typed_bindings(c))
    names = set(tracked.values())
    binding_at = set(tracked)
    for i, t in enumerate(c.toks):
        if t.kind != "id" or t.value not in names or i in binding_at or not c.free(i) or _in_spans(i, spans):
            continue
        if not _transport_use_ok(c, i, live_eval):
            out.append(f"{rel}: uses {t.value} (a transport) other than as a .send/.embed receiver, an .id read, a null check or a runLiveEvaluation argument")
    # Kept from R17: a restricted value name on an `export` line.
    for i, t in enumerate(c.toks):
        if t.kind == "id" and t.value == "export" and c.stmt_start(i):
            j = i + 1
            while j < len(c.toks) and not c.toks[j].nl:
                u = c.toks[j]
                if u.kind == "id" and u.value in VALUE_NAMES and not c.member(j):
                    out.append(f"{rel}: re-exports {u.value} (a granted file may not hand a transport on)")
                j += 1
    for name, how in derived_exports(c, set(value_locals) | whole_locals | VALUE_NAMES):
        if how == "function":
            out.append(f"{rel}: exports function {name} that returns a restricted transport")
        else:
            out.append(f"{rel}: re-exports {name} (a value derived from a restricted transport name)")
    if rel not in SEND_SITES:
        sends = [t for t in c.toks if t.kind == "id" and t.value in ("send", "embed")]
        if sends or any(v in ("send", "embed") for v in _literal_values(c)):
            out.append(f"{rel}: calls send or embed (only {', '.join(sorted(SEND_SITES))} send)")
    return out


# ---------------------------------------------------------------------------------------------------------------------
# The Gateway key and host (R32)
# ---------------------------------------------------------------------------------------------------------------------


def _literal_values(c: Code) -> list[str]:
    """Every string and template-chunk value in the file, and every `+` concatenation of literals folded into one."""
    out: list[str] = []
    toks = c.toks
    i = 0
    while i < len(toks):
        t = toks[i]
        if t.kind in ("str", "tpl"):
            out.append(t.value)
            if t.kind == "str" or t.part == "full":
                parts = [t.value]
                j = i
                while c.punct(j + 1, "+") and c.at(j + 2) is not None and (c.toks[j + 2].kind == "str" or (c.toks[j + 2].kind == "tpl" and c.toks[j + 2].part == "full")):
                    parts.append(c.toks[j + 2].value)
                    j += 2
                if len(parts) > 1:
                    out.append("".join(parts))
                    i = j + 1
                    continue
        i += 1
    return out


def gateway_findings(c: Code, rel: str) -> list[str]:
    out: list[str] = []
    values = _literal_values(c)
    keys: set[str] = set()
    for t in c.toks:
        if t.kind == "id":
            keys.update(m.group(0) for m in KEY_NAME_RE.finditer(t.value))
    for v in values:
        keys.update(m.group(0) for m in KEY_NAME_RE.finditer(v))
    if rel not in KEY_NAME_GRANTS:
        for key in sorted(keys):
            out.append(f"{rel}: names the AI Gateway key {key} (only {', '.join(sorted(KEY_NAME_GRANTS))} may)")
    elif not keys:
        out.append(f"{rel}: holds a key-name grant it does not use")
    granted = set(HOST_GRANTS.get(rel, ()))
    seen: set[str] = set()
    for v in values:
        if GATEWAY_HOST not in v.lower():
            continue
        urls = [m.group(0) for m in _HOST_URL_RE.finditer(v)]
        if not urls or any(u not in granted for u in urls):
            out.append(f"{rel}: names the AI Gateway host {GATEWAY_HOST} (only {', '.join(sorted(HOST_GRANTS))} may, each its own URL)")
        seen.update(urls)
    for url in sorted(granted - seen):
        out.append(f"{rel}: holds a host grant for {url} that it does not name")
    return out


# ---------------------------------------------------------------------------------------------------------------------
# One file
# ---------------------------------------------------------------------------------------------------------------------


def _covers_module(module: str, rel: str) -> bool:
    """Whether `rel` holds a grant for every restricted name of `module`. No file does (the test seams are granted to
    none), so a whole-module binding of a transport is refused everywhere (PR #129 review, Codex P2, thread 4368766679)."""
    return set(RESTRICTED[module]) <= set(GRANTS[module].get(rel, ()))


def file_findings(rel: str, text: str, resolver: Resolver) -> list[str]:
    out: list[str] = []
    c = Code(lex(text))
    reading = read_refs(c, rel)
    out.extend(reading.loader_findings)
    in_scope = rel.startswith(COMPUTED_SCOPE)
    for i in reading.unreadable:
        out.append(f"{rel}: an import statement the gate cannot read (line {text.count(chr(10), 0, c.toks[i].start) + 1})")
    value_locals: dict[str, str] = {}
    whole_locals: set[str] = set()
    imported: dict[str, set[str]] = {}
    live_eval: set[str] = set()
    for ref in reading.refs:
        if ref.kind == "computed":
            if in_scope:
                out.append(f"{rel}: computed module load (import() or require() of a non-literal specifier)")
            continue
        if ref.spec is None:
            continue
        spec = ref.spec.strip()
        if spec.startswith("#"):
            out.append(f"{rel}: imports {spec} through a package.json subpath import (the gate cannot resolve it)")
            continue
        if spec in ("vm", "node:vm") and in_scope:
            out.append(f"{rel}: generates code at run time (the vm module)")
        module = resolver.resolve(spec, rel)
        if module is None:
            continue
        if module == EVAL_SET and ref.kind == "import":
            live_eval.update(local for original, local in ref.names if original == "runLiveEvaluation" and local)
        if _unscanned(module) and ref.kind != "export-list":
            out.append(f"{rel}: imports {module} from an unscanned directory (G-0 does not read it)")
        if module not in RESTRICTED:
            continue
        restricted = RESTRICTED[module]
        granted = GRANTS[module].get(rel, ())
        if ref.kind == "export-from":
            if ref.whole or not ref.names:
                out.append(f"{rel}: re-exports all of {module}")
            for original, _ in ref.names:
                if original in restricted:
                    out.append(f"{rel}: re-exports {original} from {module}")
            continue
        if ref.kind == "load":
            if not _covers_module(module, rel):
                out.append(f"{rel}: loads {module} dynamically (the names it uses cannot be read)")
            continue
        if ref.kind != "import":
            continue
        if ref.whole and not _covers_module(module, rel):
            out.append(f"{rel}: imports all of {module} (a namespace or default import binds every transport name)")
        whole_locals.update(ref.whole)
        for original, local in ref.names:
            if original in restricted:
                imported.setdefault(module, set()).add(original)
                if original not in granted:
                    out.append(f"{rel}: imports {original} from {module}")
            if original in VALUE_NAMES and local:
                value_locals[local] = original
    if rel in GRANTED_FILES:
        out.extend(granted_findings(c, rel, value_locals, whole_locals, reading.import_spans, live_eval))
        for module, grants in GRANTS.items():
            for name in grants.get(rel, ()):
                if name not in imported.get(module, set()):
                    out.append(f"{rel}: holds a grant for {name} from {module} that it does not import")
    if in_scope or rel in KEY_NAME_GRANTS or rel in HOST_GRANTS:
        out.extend(gateway_findings(c, rel))
    return sorted(set(out))


def findings(root: pathlib.Path = pathlib.Path(".")) -> list[str]:
    out: list[str] = []
    resolver = Resolver(root)
    for rel_path in iter_scan_files(root):
        rel = str(rel_path).replace("\\", "/")
        if rel.startswith(EXCLUDED_PREFIXES) or rel_path.suffix.lower() not in JS_SUFFIXES:
            continue
        text = read_text(root / rel_path)
        if text is None:
            continue
        out.extend(file_findings(rel, text, resolver))
    for module, grants in GRANTS.items():
        for rel in grants:
            if not (root / rel).is_file():
                out.append(f"{rel}: stale grant for {module} (the file does not exist)")
    for rel in sorted(KEY_NAME_GRANTS | set(HOST_GRANTS)):
        if not (root / rel).is_file():
            out.append(f"{rel}: stale key-name or host grant (the file does not exist)")
    return out


def main(argv: list[str]) -> int:
    if "--print-grants" in argv:
        print(
            json.dumps(
                {
                    "restricted": RESTRICTED,
                    "grants": GRANTS,
                    "sendSites": sorted(SEND_SITES),
                    "keyNameGrants": sorted(KEY_NAME_GRANTS),
                    "hostGrants": {k: list(v) for k, v in sorted(HOST_GRANTS.items())},
                },
                indent=2,
            )
        )
        return 0
    found = findings()
    for line in found:
        print(f"FAIL: {line}")
    if found:
        print("FAIL: a P1 transport is imported outside its grants (audit F34 R1-003, R2-001; spec R17, R29 to R36)")
        return 1
    print("PASS: P1 transports are imported only by their grants; no computed module load in functions/src, platform/ or services/; the Gateway key and host are named only where granted")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
