#!/usr/bin/env python3
"""idempotency-guard — every POST/PUT/PATCH handler calls requireIdempotencyKey.

FA-Q14A-GUARD-007. An import, a comment, the header name, or a call in a function
the handler never calls is not enforcement. The helper counts when a call is
reachable from the exported handler, or when that handler passes the helper into
a callee that calls it. `export { handler as POST }`, `export let`, and `.mts`
files are handlers. The WhatsApp HMAC exemption is the POST handler only.
"""
from __future__ import annotations

import pathlib
import sys

from js_lexer import lex

SKIP_PARTS = {"node_modules", ".git", ".next", "ci_gates", "_superseded", "corpus_service", ".eve"}
WRITE_METHODS = ("POST", "PUT", "PATCH")
HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})
HMAC_WEBHOOKS = {"app/api/d2/whatsapp/route.ts"}
HELPER = "requireIdempotencyKey"


def exported_methods(text: str) -> set[str]:
    """Exported HTTP handlers. Comments and strings are not exports."""
    return {name for name in export_entries(text) if name in HTTP_METHODS}


def _opens_call(toks: list, index: int) -> bool:
    """True when toks[index] is the callee of a call, not a function declaration."""
    if index > 0 and toks[index - 1].kind == "id" and toks[index - 1].value == "function":
        return False
    nxt = index + 1
    if nxt >= len(toks) or toks[nxt].kind != "punct":
        return False
    if toks[nxt].value == "(":
        return True
    if toks[nxt].value == "?." and nxt + 1 < len(toks) and toks[nxt + 1].kind == "punct" and toks[nxt + 1].value == "(":
        return True
    return False


def helper_is_called(text: str) -> bool:
    toks = lex(text)
    for i, tok in enumerate(toks):
        if tok.kind == "id" and tok.value == HELPER and _opens_call(toks, i):
            return True
    return False


def _helper_passed(toks: list, index: int) -> bool:
    """The identifier is a value handed to a callee, not a call and not a property key."""
    if toks[index].kind != "id" or toks[index].value != HELPER or _opens_call(toks, index):
        return False
    nxt = toks[index + 1].value if index + 1 < len(toks) and toks[index + 1].kind == "punct" else ""
    if nxt == ":":
        return False
    prev = toks[index - 1].value if index > 0 and toks[index - 1].kind == "punct" else ""
    return prev in {"(", ",", ":", "{"}


def passes_helper_to(text: str, callee: str) -> bool:
    toks = lex(text)
    n = len(toks)
    for i, tok in enumerate(toks):
        if tok.kind != "id" or tok.value != callee or not _opens_call(toks, i):
            continue
        j = i + 1
        if toks[j].value == "?.":
            j += 1
        depth = 0
        k = j
        while k < n:
            if toks[k].kind == "punct" and toks[k].value in "({[":
                depth += 1
            elif toks[k].kind == "punct" and toks[k].value in ")}]":
                depth -= 1
                if depth == 0:
                    break
            elif depth >= 1 and _helper_passed(toks, k):
                return True
            k += 1
    return False


def import_map(text: str) -> dict[str, tuple[str, str]]:
    """Local binding to (module spec, exported name). Type imports are not bindings."""
    toks = lex(text)
    found: dict[str, tuple[str, str]] = {}
    n = len(toks)
    i = 0
    while i < n:
        if toks[i].kind != "id" or toks[i].value != "import":
            i += 1
            continue
        i += 1
        if i < n and toks[i].kind == "id" and toks[i].value == "type":
            while i < n and not (toks[i].kind == "str" and i > 0 and toks[i - 1].value == "from"):
                i += 1
            i += 1
            continue
        names: list[tuple[str, str]] = []
        while i < n and not (toks[i].kind == "id" and toks[i].value == "from"):
            if toks[i].kind == "id" and toks[i].value == "type" and i + 1 < n and toks[i + 1].kind == "id":
                i += 2
                continue
            if toks[i].kind == "id" and toks[i].value not in {"as", "from"}:
                exported = toks[i].value
                local = exported
                if i + 2 < n and toks[i + 1].kind == "id" and toks[i + 1].value == "as" and toks[i + 2].kind == "id":
                    local = toks[i + 2].value
                    i += 2
                names.append((local, exported))
            i += 1
        if i < n and toks[i].value == "from":
            i += 1
            if i < n and toks[i].kind == "str":
                for local, exported in names:
                    found[local] = (toks[i].value, exported)
        i += 1
    return found


def resolve_module(spec: str, source: pathlib.Path, root: pathlib.Path) -> pathlib.Path | None:
    if spec.startswith("@/"):
        base = root / spec[2:]
    elif spec.startswith("."):
        base = (source.parent / spec).resolve()
    else:
        return None
    suffixes = (".ts", ".tsx", ".mts", ".js")
    if base.suffix in suffixes and base.is_file():
        return base
    for suffix in suffixes:
        candidate = pathlib.Path(str(base) + suffix)
        if candidate.is_file():
            return candidate
    index = base / "index.ts"
    if index.is_file():
        return index
    return None


def _balanced(toks: list, index: int, open_ch: str, close_ch: str) -> int:
    depth = 0
    i = index
    while i < len(toks):
        if toks[i].kind == "punct" and toks[i].value == open_ch:
            depth += 1
        elif toks[i].kind == "punct" and toks[i].value == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return max(index, len(toks) - 1)


def _punct_at(toks: list, index: int, value: str) -> bool:
    return index < len(toks) and toks[index].kind == "punct" and toks[index].value == value


def _after_params(toks: list, index: int) -> int:
    """The token after a parameter list, skipping a TypeScript return type."""
    j = index
    if not _punct_at(toks, j, ":"):
        return j
    j += 1
    depth = 0
    while j < len(toks):
        val = toks[j].value if toks[j].kind == "punct" else ""
        if val in {"<", "("}:
            depth += 1
        elif val in {">", ")"} and depth:
            depth -= 1
        elif val == "{":
            if depth == 0:
                end = _balanced(toks, j, "{", "}")
                nxt = end + 1
                if nxt < len(toks) and toks[nxt].kind == "punct" and toks[nxt].value in {"{", "=>"}:
                    j = nxt
                    continue
                return j
            depth += 1
        elif val == "}" and depth:
            depth -= 1
        elif val == "=>" and depth == 0:
            return j
        j += 1
    return j


def _function_body(toks: list, index: int) -> tuple[str | None, int, int] | None:
    """toks[index] is `function`. Returns (name, opening brace, closing brace)."""
    j = index + 1
    name = None
    if j < len(toks) and toks[j].kind == "id":
        name = toks[j].value
        j += 1
    if not _punct_at(toks, j, "("):
        return None
    j = _after_params(toks, _balanced(toks, j, "(", ")") + 1)
    if not _punct_at(toks, j, "{"):
        return None
    return name, j, _balanced(toks, j, "{", "}")


def _arrow_body(toks: list, index: int) -> tuple[int, int] | None:
    j = index
    if j < len(toks) and toks[j].kind == "id" and toks[j].value == "async":
        j += 1
    if j >= len(toks):
        return None
    if _punct_at(toks, j, "("):
        j = _after_params(toks, _balanced(toks, j, "(", ")") + 1)
    elif toks[j].kind == "id":
        j += 1
        j = _after_params(toks, j)
    else:
        return None
    if not _punct_at(toks, j, "=>"):
        return None
    j += 1
    if _punct_at(toks, j, "{"):
        return j, _balanced(toks, j, "{", "}")
    return None


def _initializer_function(toks: list, index: int) -> tuple[int, int] | None:
    j = index
    if (
        j + 1 < len(toks)
        and toks[j].kind == "id"
        and toks[j].value == "async"
        and toks[j + 1].kind == "id"
        and toks[j + 1].value == "function"
    ):
        j += 1
    if j < len(toks) and toks[j].kind == "id" and toks[j].value == "function":
        parsed = _function_body(toks, j)
        if parsed is None:
            return None
        return parsed[1], parsed[2]
    return _arrow_body(toks, index)


def _call_arg_names(toks: list, callee: int) -> tuple[set[str], int] | None:
    if not _opens_call(toks, callee):
        return None
    j = callee + 1
    if toks[j].kind == "punct" and toks[j].value == "?.":
        j += 1
    end = _balanced(toks, j, "(", ")")
    names: set[str] = set()
    depth = 0
    for k in range(j, end + 1):
        if toks[k].kind == "punct" and toks[k].value in "({[":
            depth += 1
        elif toks[k].kind == "punct" and toks[k].value in ")}]":
            depth -= 1
        elif (
            depth >= 1
            and toks[k].kind == "id"
            and toks[k - 1].kind == "punct"
            and toks[k - 1].value in {"(", ","}
        ):
            names.add(toks[k].value)
    return names, end


def index_bindings(toks: list) -> tuple[dict[str, tuple[int, int]], dict[str, set[str]], dict[str, str]]:
    """Named function bodies, call-expression bindings, and identifier aliases."""
    bodies: dict[str, tuple[int, int]] = {}
    call_bindings: dict[str, set[str]] = {}
    aliases: dict[str, str] = {}
    i = 0
    n = len(toks)
    while i < n:
        if toks[i].kind == "id" and toks[i].value == "function":
            parsed = _function_body(toks, i)
            if parsed and parsed[0]:
                bodies[parsed[0]] = (parsed[1], parsed[2])
            i += 1
            continue
        if toks[i].kind == "id" and toks[i].value in {"const", "let", "var"} and i + 1 < n and toks[i + 1].kind == "id":
            name = toks[i + 1].value
            if i + 2 < n and toks[i + 2].kind == "punct" and toks[i + 2].value == "=" and i + 3 < n:
                fn = _initializer_function(toks, i + 3)
                if fn:
                    bodies[name] = fn
                    i = fn[0] + 1
                    continue
                if toks[i + 3].kind == "id":
                    called = _call_arg_names(toks, i + 3)
                    if called:
                        call_bindings[name] = called[0]
                        i = i + 4
                        continue
                    if not _opens_call(toks, i + 3):
                        aliases[name] = toks[i + 3].value
        i += 1
    return bodies, call_bindings, aliases


def export_entries(text: str) -> dict[str, tuple]:
    """Exported name to (`local`, local name) or (`reexport`, spec, foreign name)."""
    toks = lex(text)
    found: dict[str, tuple] = {}
    n = len(toks)
    i = 0
    while i < n:
        if toks[i].kind != "id" or toks[i].value != "export":
            i += 1
            continue
        j = i + 1
        if j < n and toks[j].kind == "id" and toks[j].value == "type":
            i = j + 1
            continue
        if j < n and toks[j].kind == "id" and toks[j].value == "async":
            j += 1
        if j < n and toks[j].kind == "id" and toks[j].value == "function":
            j += 1
            if j < n and toks[j].kind == "id":
                found[toks[j].value] = ("local", toks[j].value)
            i = j + 1
            continue
        if j < n and toks[j].kind == "id" and toks[j].value in {"const", "let", "var"}:
            j += 1
            if j < n and toks[j].kind == "id":
                found[toks[j].value] = ("local", toks[j].value)
            i = j + 1
            continue
        if j < n and toks[j].kind == "punct" and toks[j].value == "{":
            j += 1
            clause: list[tuple[str, str]] = []
            while j < n and not (toks[j].kind == "punct" and toks[j].value == "}"):
                if toks[j].kind == "id" and toks[j].value == "type":
                    j += 1
                    if j < n and toks[j].kind == "id":
                        j += 1
                    if j + 1 < n and toks[j].kind == "id" and toks[j].value == "as":
                        j += 2
                    continue
                if toks[j].kind == "id" and toks[j].value not in {"as", "from"}:
                    local = toks[j].value
                    exported = local
                    if (
                        j + 2 < n
                        and toks[j + 1].kind == "id"
                        and toks[j + 1].value == "as"
                        and toks[j + 2].kind == "id"
                    ):
                        exported = toks[j + 2].value
                        j += 2
                    clause.append((exported, local))
                j += 1
            spec = None
            if (
                j + 2 < n
                and toks[j].kind == "punct"
                and toks[j].value == "}"
                and toks[j + 1].kind == "id"
                and toks[j + 1].value == "from"
                and toks[j + 2].kind == "str"
            ):
                spec = toks[j + 2].value
            for exported, local in clause:
                if spec is None:
                    found[exported] = ("local", local)
                else:
                    found[exported] = ("reexport", spec, local)
            i = j + 1
            continue
        i += 1
    return found


def _direct(toks: list, text: str, start: int, end: int, bodies: dict[str, tuple[int, int]]) -> tuple[bool, set[str], list[str]]:
    """Calls and callbacks in this function, excluding nested function bodies."""
    nested = [span for span in bodies.values() if span[0] > start and span[1] < end]
    helper = False
    names: set[str] = set()
    recipients: list[str] = []
    i = start + 1
    while i < end:
        if any(i == ns for ns, _ne in nested):
            i = next(ne for ns, ne in nested if ns == i) + 1
            continue
        if toks[i].kind == "id" and toks[i].value == HELPER and _opens_call(toks, i):
            helper = True
        if toks[i].kind == "id" and _opens_call(toks, i):
            called = _call_arg_names(toks, i)
            if called:
                arg_names, call_end = called
                names.add(toks[i].value)
                names.update(arg_names)
                span = text[toks[i].start : toks[call_end].end]
                if passes_helper_to(span, toks[i].value):
                    recipients.append(toks[i].value)
                i = call_end + 1
                continue
        if (
            toks[i].kind == "id"
            and i > 0
            and toks[i - 1].kind == "punct"
            and toks[i - 1].value in {"(", ","}
        ):
            names.add(toks[i].value)
        i += 1
    return helper, names, recipients


def _reachable(
    text: str,
    name: str,
    root: pathlib.Path,
    source: pathlib.Path,
    seen: set[tuple[str, str]],
) -> bool:
    key = (source.as_posix(), name)
    if key in seen or len(seen) > 64:
        return False
    seen.add(key)
    entries = export_entries(text)
    if name in entries:
        kind = entries[name]
        if kind[0] == "reexport":
            module = resolve_module(kind[1], source, root)
            if module is None:
                return False
            try:
                body = module.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                return False
            return _reachable(body, kind[2], root, module, seen)
        name = kind[1]
    toks = lex(text)
    bodies, call_bindings, aliases = index_bindings(toks)
    imports = import_map(text)
    stack = [name]
    visited: set[str] = set()
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        if current in aliases and current not in bodies:
            stack.append(aliases[current])
        if current in call_bindings and current not in bodies:
            stack.extend(call_bindings[current])
        if current not in bodies:
            continue
        start, end = bodies[current]
        helper, names, recipients = _direct(toks, text, start, end, bodies)
        if helper:
            return True
        for local in names:
            if local in bodies or local in call_bindings or local in aliases:
                stack.append(local)
        for local in recipients:
            if local not in imports:
                continue
            spec, exported = imports[local]
            module = resolve_module(spec, source, root)
            if module is None:
                continue
            try:
                body = module.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if _reachable(body, exported, root, module, seen):
                return True
    return False


def method_enforced(text: str, method: str, root: pathlib.Path, rel: str) -> bool:
    return _reachable(text, method, root, root / rel, set())


def violations(rel: str, text: str, root: pathlib.Path) -> list[str]:
    methods = exported_methods(text)
    found: list[str] = []
    if rel in HMAC_WEBHOOKS:
        extra = sorted(methods - {"POST"})
        if extra:
            found.append(f"{rel}: HMAC exemption is the POST handler only; also exports {', '.join(extra)}")
    for method in sorted(methods & set(WRITE_METHODS)):
        if not method_enforced(text, method, root, rel):
            found.append(f"{rel}: {method} does not call {HELPER}")
    return found


def scan(root: pathlib.Path) -> list[str]:
    failed: list[str] = []
    for path in root.rglob("*"):
        if path.suffix not in {".ts", ".tsx", ".js", ".mts"}:
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        failed.extend(violations(rel, text, root))
    return failed


def main() -> int:
    failed = scan(pathlib.Path("."))
    if failed:
        print("FAIL: POST/PUT without idempotency:")
        for item in failed:
            print(" ", item)
        return 1
    print("PASS: POST/PUT handlers call requireIdempotencyKey")
    return 0


if __name__ == "__main__":
    sys.exit(main())
