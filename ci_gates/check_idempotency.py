#!/usr/bin/env python3
"""idempotency-guard — every POST/PUT/PATCH handler calls requireIdempotencyKey.

FA-Q14A-GUARD-007. An import, a comment, or the header name is not enforcement.
The helper counts only when it is called, or when it is passed into a called
function whose body calls it. The WhatsApp HMAC exemption is the POST handler
only: any other exported HTTP method on that file fails.
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
    toks = lex(text)
    found: set[str] = set()
    n = len(toks)
    for i, tok in enumerate(toks):
        if tok.kind != "id" or tok.value != "export":
            continue
        j = i + 1
        if j < n and toks[j].kind == "id" and toks[j].value == "async":
            j += 1
        if j >= n or toks[j].kind != "id":
            continue
        if toks[j].value == "function":
            j += 1
            if j < n and toks[j].kind == "id" and toks[j].value in HTTP_METHODS:
                found.add(toks[j].value)
        elif toks[j].value == "const":
            j += 1
            if j < n and toks[j].kind == "id" and toks[j].value in HTTP_METHODS:
                found.add(toks[j].value)
    return found


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


def import_map(text: str) -> dict[str, str]:
    """Runtime import bindings. `import type` and `type` specifiers are not bindings."""
    toks = lex(text)
    found: dict[str, str] = {}
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
        names: list[str] = []
        while i < n and not (toks[i].kind == "id" and toks[i].value == "from"):
            if toks[i].kind == "id" and toks[i].value == "type" and i + 1 < n and toks[i + 1].kind == "id":
                i += 2
                continue
            if toks[i].kind == "id" and toks[i].value not in {"as", "from"}:
                name = toks[i].value
                if i + 2 < n and toks[i + 1].value == "as" and toks[i + 2].kind == "id":
                    name = toks[i + 2].value
                    i += 2
                names.append(name)
            i += 1
        if i < n and toks[i].value == "from":
            i += 1
            if i < n and toks[i].kind == "str":
                for name in names:
                    found[name] = toks[i].value
        i += 1
    return found


def resolve_module(spec: str, source: pathlib.Path, root: pathlib.Path) -> pathlib.Path | None:
    if spec.startswith("@/"):
        base = root / spec[2:]
    elif spec.startswith("."):
        base = (source.parent / spec).resolve()
    else:
        return None
    if base.suffix in {".ts", ".tsx", ".js"} and base.is_file():
        return base
    for suffix in (".ts", ".tsx", ".js"):
        candidate = pathlib.Path(str(base) + suffix)
        if candidate.is_file():
            return candidate
    index = base / "index.ts"
    if index.is_file():
        return index
    return None


def applies(text: str, root: pathlib.Path, rel: str) -> bool:
    if helper_is_called(text):
        return True
    source = root / rel
    for local, spec in import_map(text).items():
        if not passes_helper_to(text, local):
            continue
        module = resolve_module(spec, source, root)
        if module is None:
            continue
        try:
            body = module.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if helper_is_called(body):
            return True
    return False


def violations(rel: str, text: str, root: pathlib.Path) -> list[str]:
    methods = exported_methods(text)
    found: list[str] = []
    if rel in HMAC_WEBHOOKS:
        extra = sorted(methods - {"POST"})
        if extra:
            found.append(f"{rel}: HMAC exemption is the POST handler only; also exports {', '.join(extra)}")
    for method in sorted(methods & set(WRITE_METHODS)):
        if not applies(text, root, rel):
            found.append(f"{rel}: {method} does not call {HELPER}")
    return found


def scan(root: pathlib.Path) -> list[str]:
    failed: list[str] = []
    for path in root.rglob("*"):
        if path.suffix not in {".ts", ".tsx", ".js"}:
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
