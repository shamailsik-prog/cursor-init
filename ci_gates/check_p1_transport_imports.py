#!/usr/bin/env python3
"""p1-transport-import guard (audit F34 R1-003; G-0 check [21]).

Every prompt the P1 path sends must come from a registered template (spec
docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, rulings R3 and R17). The re-audit showed
that a call-site regex is bypassed by an ordinary alias (`const gw = activeTransport(); await gw?.send(...)`) or by a
send placed outside the scanned tree. This guard rules on imports instead: only the files granted below may import a
P1 transport, and the grants are the send sites, which build every message with `buildOutbound`.

Restricted names (RESTRICTED): `functions/src/p1/transport`'s `activeTransport`, `gatewayTransport`, `P1Transport` and
`setP1TransportForTests`; `functions/src/p1/embeddingTransport`'s `activeEmbeddingTransport`,
`gatewayEmbeddingTransport`, `P1EmbeddingTransport` and `setP1EmbeddingTransportForTests`. Every other export of those
modules (`modelId`, `plainId`, the error classes, the constants, the reply types) stays importable.

Grants (GRANTS): gateway.ts and evalSet.ts (the chat send sites), embedding.ts (the embedding send site), and the
operator CLI functions/src/cli/committeeEval.ts, which builds the Gateway transport from the operator's key and hands it
to evalSet.ts's `runLiveEvaluation`; a granted file that is not a send site must hold no `send` or `embed` token. The
test seams are granted to no source file.

Scope: every JS/TS file the G-0 walker yields (g0_guard_common.iter_scan_files) except functions/test/ (the tests use
the seams) and functions/lib/ (build output). That covers functions/src, platform/ and services/, and the rest of the
tree, where F18's check [19](e) already refuses any import of a non-pure Functions module.

It fails on, outside a grant:
  - a named import or an `export { } from` re-export of a restricted name (type-only included; `as` resolved to the
    original name).
And anywhere in scope, granted files included (PR #129 review, Codex P2, thread 4368766679: a grant is per name, so a
whole-module binding in a granted file must not reach the names it was not granted):
  - a namespace import, a default import, `export *` or `export * as` of a transport module, and any `import()`,
    `require()`, `require.resolve()`, createRequire loader or vitest/jest importActual / requireActual / importMock /
    requireMock of one (the names it uses cannot be read: fail closed). These pass only in a file granted every
    restricted name of the module, and no file is (the test seams are granted to none);
  - a granted file exporting a restricted value or a value derived from one (`derived_exports`): `export {
    activeTransport }`, `export default gatewayTransport`, `export const t = activeTransport`, and `const t =
    activeTransport` (or `transport.activeTransport()`) followed by `export { t }`, `export default t`, `export =` or
    `module.exports`; any `export ... from` of a restricted name;
  - under functions/src, platform/ and services/, an `import()` or `require()` whose specifier is not exactly one
    string literal (`computed_load`, read token by token so whitespace and comments after the parenthesis are skipped,
    PR #129 review, Codex P2, thread 4368766681): a variable, a call, a concatenation or a template literal with a
    substitution;
  - a grant whose file is missing (a stale grant).
A side-effect `import "…/transport"` binds nothing and passes. Specifiers resolve by path: relative, the `@/` alias or a
bare repository path, with or without a JS/TS extension or `/index`, a query or a hash.

`--print-grants` prints RESTRICTED and GRANTS as JSON (tests/f34-p1-transport-import-gate.test.ts reads it).
Residual (spec R17, residual 11): in a granted file, a function that returns a transport, a derived value whose
initializer spans several lines, and a transport stored in an object property are not traced; the four grants are
reviewed with this gate.
"""
from __future__ import annotations

import json
import pathlib
import posixpath
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from g0_guard_common import JS_SUFFIXES, JS_WS, _create_require_specifiers, iter_scan_files, read_text  # noqa: E402

TRANSPORT = "functions/src/p1/transport"
EMBEDDING_TRANSPORT = "functions/src/p1/embeddingTransport"

RESTRICTED: dict[str, tuple[str, ...]] = {
    TRANSPORT: ("activeTransport", "gatewayTransport", "P1Transport", "setP1TransportForTests"),
    EMBEDDING_TRANSPORT: ("activeEmbeddingTransport", "gatewayEmbeddingTransport", "P1EmbeddingTransport", "setP1EmbeddingTransportForTests"),
}
# Names that are values (a re-export of one hands out a transport or its seam); the two `P1...Transport` names are types.
VALUE_NAMES = frozenset(n for names in RESTRICTED.values() for n in names if not n.startswith("P1"))

GRANTS: dict[str, dict[str, tuple[str, ...]]] = {
    TRANSPORT: {
        "functions/src/p1/gateway.ts": ("activeTransport", "gatewayTransport", "P1Transport"),
        "functions/src/p1/evalSet.ts": ("activeTransport", "gatewayTransport", "P1Transport"),
        "functions/src/cli/committeeEval.ts": ("gatewayTransport", "P1Transport"),
    },
    EMBEDDING_TRANSPORT: {
        "functions/src/p1/embedding.ts": ("activeEmbeddingTransport", "gatewayEmbeddingTransport", "P1EmbeddingTransport"),
    },
}
# The granted files that send. Any other granted file may build or name a transport, never call it.
SEND_SITES = frozenset({"functions/src/p1/gateway.ts", "functions/src/p1/evalSet.ts", "functions/src/p1/embedding.ts"})

EXCLUDED_PREFIXES = ("functions/test/", "functions/lib/")
COMPUTED_SCOPE = ("functions/src/", "platform/", "services/")

_JS_EXT_RE = re.compile(r"\.(?:[cm]?[jt]sx?)$", re.I)
_STRING = r"""(?P<q>["'`])(?P<spec>[^"'`\r\n]+)(?P=q)"""
# A static import or export-from: the clause holds only identifiers, `type`, `as`, `*`, braces, commas, whitespace and
# comments, so prose or code that happens to precede a `from "..."` is never read as one.
_CLAUSE = r"(?P<clause>(?:[\w$\s{},*]|/\*.*?\*/|//[^\n]*(?:\n|$))*?)"
_STATIC_RE = re.compile(rf"(?<![\w$.])(?P<kw>import|export)(?![\w$]){_CLAUSE}{JS_WS}(?<![\w$])from{JS_WS}{_STRING}", re.DOTALL)
# import("x"), require("x"), require.resolve("x")
_DYNAMIC_RE = re.compile(rf"(?<![\w$.])(?:import|require(?:{JS_WS}\.{JS_WS}resolve)?){JS_WS}\({JS_WS}{_STRING}", re.DOTALL)
# vi.importActual<T>("x") and the other test loaders (one nested type argument, as F18's rule (e) reads them).
_TEST_LOADER_RE = re.compile(
    rf"\b(?:vi|jest){JS_WS}\.{JS_WS}(?:importActual|requireActual|importMock|requireMock){JS_WS}(?:<(?:[^<>()]|<[^<>()]*>)*>)?{JS_WS}\({JS_WS}{_STRING}",
    re.DOTALL,
)
# An import( or require( call, read on comment-blanked text; `computed_load` reads its argument token by token.
_LOADER_CALL_RE = re.compile(r"(?<![\w$.])(?:import|require)\s*\(")
_COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.DOTALL)
_SEND_TOKEN_RE = re.compile(r"(?<![\w$])(?:send|embed)(?![\w$])")
_IDENT = r"[A-Za-z_$][\w$]*"
# `const x = <initializer on the same line>` (an optional type annotation), and `const { a, b: c } = <initializer>`.
_DECL_RE = re.compile(rf"(?<![\w$.])(?:const|let|var)\s+({_IDENT})\s*(?::[^=\n]*)?=(?![=>])\s*([^\n;]*)")
_DESTRUCTURE_RE = re.compile(r"(?<![\w$.])(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=\n]*)?=(?![=>])\s*([^\n;]*)")
# `export { a, b as c }` with no `from` after it (an export-from is read by _STATIC_RE).
_EXPORT_LIST_RE = re.compile(r"(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)")
_EXPORT_DEFAULT_RE = re.compile(rf"(?<![\w$.])export\s+default\s+({_IDENT})\s*(?:;|$)", re.M)
_EXPORT_DECL_RE = re.compile(rf"(?<![\w$.])export\s+(?:const|let|var)\s+({_IDENT})\s*(?::[^=\n]*)?=(?![=>])\s*([^\n;]*)")
_EXPORT_ASSIGN_RE = re.compile(rf"(?<![\w$.])(?:export\s*=|module\s*\.\s*exports\s*(?:\.\s*{_IDENT}\s*)?=|exports\s*\.\s*{_IDENT}\s*=)\s*([^\n;]*)")


def strip_comments(text: str) -> str:
    """The text with `//` and `/* */` comments blanked (newlines kept), outside '...', "..." and `...` literals, so prose
    such as "may import (audit F18)" in a comment is never read as code. Regex literals are not tracked; a `//` or `/*`
    inside one blanks the rest of the comment it seems to open, which can only hide a match, never invent one."""
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


def computed_load(code: str) -> bool:
    """Whether comment-blanked `code` calls import() or require() with anything but one string literal as its specifier
    (PR #129 review, Codex P2, thread 4368766681). The argument is read token by token, so whitespace, a line break or a
    comment (already blanked) after the parenthesis is skipped, never mistaken for the argument. A literal passes only
    when it is the whole specifier: the next token is `)` or the `,` of import options. A template literal with a
    substitution, a variable, a call or a concatenation is computed."""
    n = len(code)
    for m in _LOADER_CALL_RE.finditer(code):
        i = m.end()
        while i < n and code[i].isspace():
            i += 1
        if i >= n:
            return True
        quote = code[i]
        if quote == ")":
            continue
        if quote not in "'\"`":
            return True
        j = i + 1
        while j < n and code[j] != quote:
            if code[j] == "\\":
                j += 2
                continue
            if quote == "`" and code.startswith("${", j):
                return True
            if quote != "`" and code[j] == "\n":
                return True
            j += 1
        if j >= n:
            return True
        j += 1
        while j < n and code[j].isspace():
            j += 1
        if j >= n or code[j] not in "),":
            return True
    return False


def _mentions(text: str, names: set[str]) -> str | None:
    """The first of `names` used as an identifier in `text` (not as a property after a dot), or None."""
    for name in sorted(names):
        if re.search(rf"(?<![\w$.]){re.escape(name)}(?![\w$])", text):
            return name
    return None


def derived_exports(code: str, bound: set[str]) -> list[str]:
    """The exported local names that hold a restricted transport value or a value derived from one (PR #129 review,
    Codex P2, thread 4368766681). `bound` is what the file's imports of a transport module bound (the restricted value
    names, their `as` aliases, a namespace or default binding). A `const`/`let`/`var` whose same-line initializer uses a
    tainted name is tainted, to a fixpoint; then `export { x }`, `export default x`, `export const y = <tainted>`,
    `export =` and `module.exports` / `exports.x =` of a tainted name fail. Limits (spec R17, residual 11): an initializer
    spread over several lines, a function that returns a transport, and a transport stored in an object property are not
    traced."""
    tainted = set(bound)
    changed = True
    while changed:
        changed = False
        for m in _DECL_RE.finditer(code):
            if m.group(1) not in tainted and _mentions(m.group(2), tainted):
                tainted.add(m.group(1))
                changed = True
        for m in _DESTRUCTURE_RE.finditer(code):
            if _mentions(m.group(2), tainted):
                for item in m.group(1).split(","):
                    local = item.split(":")[-1].split("=")[0].strip()
                    if re.fullmatch(_IDENT, local) and local not in tainted:
                        tainted.add(local)
                        changed = True
    exported: set[str] = set()
    for m in _EXPORT_LIST_RE.finditer(code):
        for item in m.group(1).split(","):
            words = item.split()
            if words and words[0] == "type":
                words = words[1:]
            if words and words[0] in tainted:
                exported.add(words[0])
    for m in _EXPORT_DEFAULT_RE.finditer(code):
        if m.group(1) in tainted:
            exported.add(m.group(1))
    for m in _EXPORT_DECL_RE.finditer(code):
        if _mentions(m.group(2), tainted):
            exported.add(m.group(1))
    for m in _EXPORT_ASSIGN_RE.finditer(code):
        hit = _mentions(m.group(1), tainted)
        if hit:
            exported.add(hit)
    return sorted(exported)


def _module_id(path: str) -> str:
    p = _JS_EXT_RE.sub("", path)
    return p[: -len("/index")] if p.endswith("/index") else p


def resolve(spec: str, importer: str) -> str | None:
    """Repository module a literal specifier names, or None for a package, a URL or a path that leaves the repo."""
    raw = spec.strip().split("?", 1)[0].split("#", 1)[0].strip()
    if not raw or ":" in raw.split("/", 1)[0] or raw.startswith("/"):
        return None
    if raw.startswith("@/"):
        path = raw[2:]
    elif raw.startswith(("./", "../")) or raw in {".", ".."}:
        path = posixpath.normpath(posixpath.join(posixpath.dirname(importer), raw))
    else:
        path = raw
    path = posixpath.normpath(_module_id(path))
    return None if path == ".." or path.startswith("../") else path


def _names(clause: str) -> tuple[list[str], bool]:
    """The original names a clause binds from its braces, and whether it also binds the whole module (default or *)."""
    text = _COMMENT_RE.sub(" ", clause)
    text = re.sub(r"^\s*type\b", " ", text)
    whole = False
    braces = re.search(r"\{(.*)\}", text, re.DOTALL)
    outside = text if braces is None else text[: braces.start()] + text[braces.end():]
    if "*" in outside or re.search(r"[A-Za-z_$][\w$]*", outside.replace(",", " ")):
        whole = True
    names: list[str] = []
    if braces is not None:
        for item in braces.group(1).split(","):
            words = item.split()
            if words and words[0] == "type":
                words = words[1:]
            if words:
                names.append(words[0])
    return names, whole


def _bindings(clause: str) -> list[str]:
    """The local names an import clause binds: `a`, the `b` of `a as b`, a default binding, the `ns` of `* as ns`."""
    text = re.sub(r"^\s*type\b", " ", _COMMENT_RE.sub(" ", clause))
    braces = re.search(r"\{(.*)\}", text, re.DOTALL)
    out: list[str] = []
    if braces is not None:
        for item in braces.group(1).split(","):
            words = [w for w in item.split() if w != "type"]
            if words:
                out.append(words[-1])
    outside = text if braces is None else text[: braces.start()] + text[braces.end():]
    out += re.findall(_IDENT, outside.replace(" as ", " "))
    return [b for b in out if b != "as"]


def _covers_module(module: str, rel: str) -> bool:
    """Whether `rel` holds a grant for every restricted name of `module`. No file does (the test seams are granted to
    none), so a whole-module binding of a transport is refused everywhere (PR #129 review, Codex P2, thread 4368766679)."""
    return set(RESTRICTED[module]) <= set(GRANTS[module].get(rel, ()))


def file_findings(rel: str, text: str) -> list[str]:
    out: list[str] = []
    # What this file's imports of a transport bound: restricted value names under their local names, and whole-module
    # bindings. Read by derived_exports for a granted file.
    bound: set[str] = set()
    for m in _STATIC_RE.finditer(text):
        module = resolve(m.group("spec"), rel)
        if module not in RESTRICTED:
            continue
        kw = m.group("kw")
        names, whole = _names(m.group("clause"))
        granted = GRANTS[module].get(rel, ())
        if kw == "export":
            if whole or not names:
                out.append(f"{rel}: re-exports all of {module}")
            for name in names:
                if name in RESTRICTED[module]:
                    out.append(f"{rel}: re-exports {name} from {module}")
            continue
        # A namespace or default binding reaches every restricted name, whatever the file's name-level grant (Codex P2).
        if whole and not _covers_module(module, rel):
            out.append(f"{rel}: imports all of {module} (a namespace or default import binds every transport name)")
        for name in names:
            if name in RESTRICTED[module] and name not in granted:
                out.append(f"{rel}: imports {name} from {module}")
        locals_ = _bindings(m.group("clause"))
        for local, original in zip(locals_[: len(names)], names):
            if original in VALUE_NAMES:
                bound.add(local)
        if whole:
            bound.update(locals_[len(names):])
    specs = [m.group("spec") for r in (_DYNAMIC_RE, _TEST_LOADER_RE) for m in r.finditer(text)] + _create_require_specifiers(text)
    for spec in specs:
        module = resolve(spec, rel)
        # The names a dynamic load uses cannot be read, so it is refused unless the file holds every name (none does).
        if module in RESTRICTED and not _covers_module(module, rel):
            out.append(f"{rel}: loads {module} dynamically (the names it uses cannot be read)")
    code = strip_comments(text)
    if rel.startswith(COMPUTED_SCOPE) and computed_load(code):
        out.append(f"{rel}: computed module load (import() or require() of a non-literal specifier)")
    granted_any = any(rel in g for g in GRANTS.values())
    if granted_any:
        for line in code.splitlines():
            if re.match(r"\s*export\b", line):
                for name in VALUE_NAMES:
                    if re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", line):
                        out.append(f"{rel}: re-exports {name} (a granted file may not hand a transport on)")
        for name in derived_exports(code, bound | VALUE_NAMES):
            out.append(f"{rel}: re-exports {name} (a value derived from a restricted transport name)")
        if rel not in SEND_SITES and _SEND_TOKEN_RE.search(code):
            out.append(f"{rel}: calls send or embed (only {', '.join(sorted(SEND_SITES))} send)")
    return sorted(set(out))


def findings(root: pathlib.Path = pathlib.Path(".")) -> list[str]:
    out: list[str] = []
    for rel_path in iter_scan_files(root):
        rel = str(rel_path).replace("\\", "/")
        if rel.startswith(EXCLUDED_PREFIXES) or rel_path.suffix.lower() not in JS_SUFFIXES:
            continue
        text = read_text(root / rel_path)
        if text is None:
            continue
        out.extend(file_findings(rel, text))
    for module, grants in GRANTS.items():
        for rel in grants:
            if not (root / rel).is_file():
                out.append(f"{rel}: stale grant for {module} (the file does not exist)")
    return out


def main(argv: list[str]) -> int:
    if "--print-grants" in argv:
        print(json.dumps({"restricted": RESTRICTED, "grants": GRANTS, "sendSites": sorted(SEND_SITES)}, indent=2))
        return 0
    found = findings()
    for line in found:
        print(f"FAIL: {line}")
    if found:
        print("FAIL: a P1 transport is imported outside its grants (audit F34 R1-003; spec R17)")
        return 1
    print("PASS: P1 transports are imported only by their grants; no computed module load in functions/src, platform/ or services/")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
