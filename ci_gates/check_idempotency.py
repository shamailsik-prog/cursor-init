#!/usr/bin/env python3
"""idempotency-guard — every POST/PUT/PATCH handler calls requireIdempotencyKey.

FA-Q14A-GUARD-007. An import, a comment, the header name, a bare binding, or a
call the handler never reaches is not enforcement. The helper counts when a
call can run on the way out of the exported handler.

What counts as a call:
- `requireIdempotencyKey(...)` or `requireIdempotencyKey?.(...)` in code the
  handler reaches, including through local functions and `const x = callee(fn)`
- an import alias (`import { requireIdempotencyKey as ensureKey }`) and a
  local `const ensureKey = requireIdempotencyKey`, when that name is called
- passing the helper value through local functions (two hops: the parameter
  that received it is a call when that parameter is called)
- passing it into an imported callee whose body calls it

What does not count:
- `if (false)` around the only call, with or without braces
- a call on a later line after `return` or `throw` in that same block
- an expression-arrow (`const unused = () => requireIdempotencyKey(request)`)
  or other nested function the handler never calls
- a local no-op that shadows the name (`const requireIdempotencyKey = () => ""`)
- `const k = requireIdempotencyKey` when `k` is never called
- `obj.post(...)`. A method call is not an HTTP handler and does not hide a
  real call in the same function

A return inside `if`, `try`, or `else` does not hide a later call. The gate
does not run the program: it does not treat `if (0)`, `if (!true)`, or a call
hidden in `eval` as dead or alive by execution. A call nested inside another
call's arguments (`new Response(requireIdempotencyKey(request))`) is not seen;
`return requireIdempotencyKey(request)` is. Files are `route.ts`, `route.tsx`,
`route.js`, `route.jsx`, and `.mts`. The WhatsApp HMAC exemption is the POST
handler only: another exported method on that file is a violation even when
that method calls the helper.
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
    suffixes = (".ts", ".tsx", ".mts", ".js", ".jsx")
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


def _param_names(toks: list, open_paren: int) -> tuple[str, ...]:
    """Parameter names of the list that opens at open_paren. Nested lists are not parameters."""
    end = _balanced(toks, open_paren, "(", ")")
    names: list[str] = []
    depth = 0
    skip = False
    i = open_paren
    while i <= end:
        val = toks[i].value if toks[i].kind == "punct" else ""
        if toks[i].kind == "punct" and val in {"(", "[", "{"}:
            depth += 1
        elif toks[i].kind == "punct" and val in {")", "]", "}"}:
            depth -= 1
            skip = False
        elif depth == 1 and toks[i].kind == "punct" and val in {":", "="}:
            skip = True
        elif depth == 1 and toks[i].kind == "punct" and val == ",":
            skip = False
        elif depth == 1 and toks[i].kind == "id" and not skip:
            names.append(toks[i].value)
            skip = True
        i += 1
    return tuple(names)


def _continues_expression(toks: list, index: int) -> bool:
    """A newline before toks[index] does not end the statement or expression."""
    if index >= len(toks):
        return False
    val = toks[index].value if toks[index].kind == "punct" else ""
    if val in {
        ".", "?.", "(", "[", ",", "=>", "+", "-", "*", "/", "%", "&", "|", "^", "?", ":",
        "<", ">", "=", "!", "~", "&&", "||", "??", "==", "===", "!=", "!==", "<=", ">=",
        "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "**=",
    }:
        return True
    if toks[index].kind == "id" and toks[index].value in {"in", "of", "instanceof"}:
        return True
    if index <= 0:
        return False
    prev = toks[index - 1]
    pval = prev.value if prev.kind == "punct" else ""
    if pval in {
        ".", "?.", "(", "[", ",", "=>", "+", "-", "*", "/", "%", "&", "|", "^", "?", ":",
        "<", ">", "=", "!", "~", "&&", "||", "??", "==", "===", "!=", "!==", "<=", ">=",
        "<<", ">>", ">>>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**",
    }:
        return True
    return prev.kind == "id" and prev.value in {
        "typeof", "void", "delete", "new", "await", "yield", "instanceof", "in", "of",
        "return", "throw", "case", "else",
    }


def _expression_end(toks: list, start: int) -> int:
    """Index of the first token after the expression that begins at start."""
    depth = 0
    i = start
    n = len(toks)
    while i < n:
        val = toks[i].value if toks[i].kind == "punct" else ""
        if toks[i].kind == "punct" and val in {"(", "[", "{"}:
            depth += 1
        elif toks[i].kind == "punct" and val in {")", "]", "}"}:
            if depth == 0:
                return i
            depth -= 1
        elif depth == 0 and toks[i].kind == "punct" and val in {";", ","}:
            return i
        elif depth == 0 and i > start and toks[i].nl and not _continues_expression(toks, i):
            return i
        i += 1
    return n


def _statement_end(toks: list, start: int, limit: int) -> int:
    """Index of the first token after the statement that begins at start."""
    depth = 0
    begun = False
    i = start
    while i < limit:
        val = toks[i].value if toks[i].kind == "punct" else ""
        if toks[i].kind == "punct" and val in {"(", "[", "{"}:
            depth += 1
            begun = True
        elif toks[i].kind == "punct" and val in {")", "]", "}"}:
            if depth == 0:
                return i
            depth -= 1
            begun = True
        elif depth == 0 and toks[i].kind == "punct" and val == ";":
            return i + 1
        elif depth == 0 and begun and i > start and toks[i].nl and not _continues_expression(toks, i):
            return i
        else:
            begun = True
        i += 1
    return i


def _keyword_stmt(toks: list, index: int, word: str) -> bool:
    if index < 0 or index >= len(toks) or toks[index].kind != "id" or toks[index].value != word:
        return False
    if index > 0 and toks[index - 1].kind == "punct" and toks[index - 1].value in {".", "?."}:
        return False
    return True


def _function_body(toks: list, index: int) -> tuple[str | None, int, int, tuple[str, ...]] | None:
    """toks[index] is `function`. Returns (name, interior start, interior end, parameters)."""
    j = index + 1
    name = None
    if j < len(toks) and toks[j].kind == "id":
        name = toks[j].value
        j += 1
    if not _punct_at(toks, j, "("):
        return None
    params = _param_names(toks, j)
    j = _after_params(toks, _balanced(toks, j, "(", ")") + 1)
    if not _punct_at(toks, j, "{"):
        return None
    return name, j + 1, _balanced(toks, j, "{", "}"), params


def _arrow_body(toks: list, index: int) -> tuple[int, int, tuple[str, ...]] | None:
    """A block or expression arrow. The span is the interior [start, end)."""
    j = index
    if j < len(toks) and toks[j].kind == "id" and toks[j].value == "async":
        j += 1
    if j >= len(toks):
        return None
    if _punct_at(toks, j, "("):
        params = _param_names(toks, j)
        j = _after_params(toks, _balanced(toks, j, "(", ")") + 1)
    elif toks[j].kind == "id":
        params = (toks[j].value,)
        j += 1
        j = _after_params(toks, j)
    else:
        return None
    if not _punct_at(toks, j, "=>"):
        return None
    j += 1
    if _punct_at(toks, j, "{"):
        return j + 1, _balanced(toks, j, "{", "}"), params
    return j, _expression_end(toks, j), params


def _initializer_function(toks: list, index: int) -> tuple[int, int, tuple[str, ...]] | None:
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
        return parsed[1], parsed[2], parsed[3]
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


def index_bindings(
    toks: list,
) -> tuple[dict[str, tuple[int, int, tuple[str, ...]]], dict[str, set[str]], dict[str, str]]:
    """Named function bodies, call-expression bindings, and identifier aliases."""
    bodies: dict[str, tuple[int, int, tuple[str, ...]]] = {}
    call_bindings: dict[str, set[str]] = {}
    aliases: dict[str, str] = {}
    i = 0
    n = len(toks)
    while i < n:
        if toks[i].kind == "id" and toks[i].value == "function":
            parsed = _function_body(toks, i)
            if parsed and parsed[0]:
                bodies[parsed[0]] = (parsed[1], parsed[2], parsed[3])
            i += 1
            continue
        if toks[i].kind == "id" and toks[i].value in {"const", "let", "var"} and i + 1 < n and toks[i + 1].kind == "id":
            name = toks[i + 1].value
            if i + 2 < n and toks[i + 2].kind == "punct" and toks[i + 2].value == "=" and i + 3 < n:
                fn = _initializer_function(toks, i + 3)
                if fn:
                    bodies[name] = fn
                    i = fn[0]
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


def _helper_names(text: str, aliases: dict[str, str], bodies: dict[str, tuple[int, int, tuple[str, ...]]]) -> set[str]:
    """The helper, its import aliases, and locals that copy that value rather than shadow it."""
    names = {HELPER}
    for local, (_spec, exported) in import_map(text).items():
        if exported == HELPER:
            names.add(local)
    changed = True
    while changed:
        changed = False
        for local, target in aliases.items():
            if target in names and local not in names and local not in bodies:
                names.add(local)
                changed = True
    return names


def _is_property(toks: list, index: int) -> bool:
    return index > 0 and toks[index - 1].kind == "punct" and toks[index - 1].value in {".", "?."}


def _shadows(
    toks: list,
    lo: int,
    hi: int,
    params: tuple[str, ...],
    helper_names: set[str],
    aliases: dict[str, str],
) -> set[str]:
    """Names in this function that hide the helper. A parameter is a shadow until a call taints it."""
    shadowed = {name for name in params if name in helper_names}
    i = lo
    while i < hi:
        if toks[i].kind == "id" and toks[i].value in {"const", "let", "var"} and i + 1 < hi and toks[i + 1].kind == "id":
            name = toks[i + 1].value
            if name in helper_names and aliases.get(name) not in helper_names:
                shadowed.add(name)
        elif toks[i].kind == "id" and toks[i].value == "function" and i + 1 < hi and toks[i + 1].kind == "id":
            if toks[i + 1].value in helper_names:
                shadowed.add(toks[i + 1].value)
        i += 1
    return shadowed


def _bare_arg(tokens: list) -> str | None:
    """A single identifier, optionally with a non-null assertion. Anything else is not a passed binding."""
    ids = [tok for tok in tokens if tok.kind == "id"]
    if len(ids) != 1:
        return None
    if any(tok.kind not in {"id", "punct"} for tok in tokens):
        return None
    if any(tok.kind == "punct" and tok.value not in {"?", "!"} for tok in tokens):
        return None
    return ids[0].value


def _positional_args(toks: list, callee: int) -> tuple[tuple[str | None, ...], int] | None:
    if not _opens_call(toks, callee):
        return None
    j = callee + 1
    if toks[j].kind == "punct" and toks[j].value == "?.":
        j += 1
    end = _balanced(toks, j, "(", ")")
    args: list[str | None] = []
    depth = 0
    current: list = []
    for k in range(j, end + 1):
        val = toks[k].value if toks[k].kind == "punct" else ""
        if toks[k].kind == "punct" and val in {"(", "[", "{"}:
            depth += 1
            if depth > 1:
                current.append(toks[k])
        elif toks[k].kind == "punct" and val in {")", "]", "}"}:
            if depth == 1 and val == ")":
                args.append(_bare_arg(current))
                break
            depth -= 1
            current.append(toks[k])
        elif toks[k].kind == "punct" and depth == 1 and val == ",":
            args.append(_bare_arg(current))
            current = []
        elif depth >= 1:
            current.append(toks[k])
    return tuple(args), end


def _dead_indexes(toks: list, lo: int, hi: int, nested: list[tuple[int, int]]) -> set[int]:
    """Tokens that cannot run: `if (false)` and the lines after `return` or `throw` in that block.

    A return inside `if`, `else`, `try`, or another brace does not kill the block that contains it.
    `if (0)` and `if (!true)` are not decided here; the gate does not execute the condition.
    """
    dead: set[int] = set()

    def jump(index: int) -> int | None:
        for start, end in nested:
            if start <= index < end:
                return end
        return None

    def walk(start: int, end: int) -> None:
        i = start
        unreachable = False
        while i < end:
            jumped = jump(i)
            if jumped is not None:
                i = jumped
                continue
            if unreachable:
                dead.add(i)
                i += 1
                continue
            if _keyword_stmt(toks, i, "if") and _punct_at(toks, i + 1, "("):
                cond_end = _balanced(toks, i + 1, "(", ")")
                cond = toks[i + 2 : cond_end]
                is_false = len(cond) == 1 and cond[0].kind == "id" and cond[0].value == "false"
                cons = cond_end + 1
                if cons < end and _punct_at(toks, cons, "{"):
                    block_end = _balanced(toks, cons, "{", "}")
                    if is_false:
                        for k in range(cons, min(block_end + 1, end)):
                            dead.add(k)
                    else:
                        walk(cons + 1, block_end)
                    i = block_end + 1
                else:
                    sent_end = _statement_end(toks, cons, end)
                    if is_false:
                        for k in range(cons, sent_end):
                            dead.add(k)
                    i = sent_end
                if i < end and _keyword_stmt(toks, i, "else"):
                    i += 1
                    if i < end and _punct_at(toks, i, "{"):
                        block_end = _balanced(toks, i, "{", "}")
                        walk(i + 1, block_end)
                        i = block_end + 1
                    elif i < end and _keyword_stmt(toks, i, "if"):
                        continue
                    else:
                        i = _statement_end(toks, i, end)
                continue
            if _keyword_stmt(toks, i, "return") or _keyword_stmt(toks, i, "throw"):
                i = _statement_end(toks, i, end)
                unreachable = True
                continue
            if _punct_at(toks, i, "{"):
                block_end = _balanced(toks, i, "{", "}")
                walk(i + 1, block_end)
                i = block_end + 1
                continue
            i += 1

    walk(lo, hi)
    return dead


def _passed_in_span(span: str, callee: str, names: set[str]) -> bool:
    toks = lex(span)
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
            elif depth >= 1 and toks[k].kind == "id" and toks[k].value in names and not _opens_call(toks, k):
                nxt = toks[k + 1].value if k + 1 < n and toks[k + 1].kind == "punct" else ""
                prev = toks[k - 1].value if k > 0 and toks[k - 1].kind == "punct" else ""
                if nxt != ":" and prev in {"(", ",", ":", "{"}:
                    return True
            k += 1
    return False


def _scan_body(
    toks: list,
    text: str,
    lo: int,
    hi: int,
    bodies: dict[str, tuple[int, int, tuple[str, ...]]],
    helper_names: set[str],
    tainted: frozenset[str],
    shadowed: set[str],
) -> tuple[bool, set[str], list[str], list[tuple[str, tuple[str | None, ...]]]]:
    """Live calls in [lo, hi). Nested functions are skipped; the caller follows a name it invokes."""
    nested = [(blo, bhi) for blo, bhi, _params in bodies.values() if (blo, bhi) != (lo, hi) and lo <= blo and bhi <= hi]
    dead = _dead_indexes(toks, lo, hi, nested)
    helper = False
    names: set[str] = set()
    recipients: list[str] = []
    calls: list[tuple[str, tuple[str | None, ...]]] = []
    i = lo
    while i < hi:
        jumped = next((end for start, end in nested if start <= i < end), None)
        if jumped is not None:
            i = jumped
            continue
        if toks[i].kind == "id" and _opens_call(toks, i):
            called = _call_arg_names(toks, i)
            positional = _positional_args(toks, i)
            if called and positional:
                arg_names, call_end = called
                args, _end = positional
                callee = toks[i].value
                live = i not in dead
                prop = _is_property(toks, i)
                if live and (callee in tainted or (callee in helper_names and (prop or callee not in shadowed))):
                    helper = True
                if live:
                    if not prop:
                        names.add(callee)
                    names.update(arg_names)
                    calls.append((callee, args))
                    span = text[toks[i].start : toks[call_end].end]
                    passed = {name for name in helper_names if name not in shadowed} | set(tainted)
                    if _passed_in_span(span, callee, passed):
                        recipients.append(callee)
                i = call_end + 1
                continue
        i += 1
    return helper, names, recipients, calls


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
    helper_names = _helper_names(text, aliases, bodies)
    stack: list[tuple[str, frozenset[str]]] = [(name, frozenset())]
    visited: set[tuple[str, frozenset[str]]] = set()
    while stack:
        current, tainted = stack.pop()
        state = (current, tainted)
        if state in visited or len(visited) > 256:
            continue
        visited.add(state)
        if current in aliases and current not in bodies:
            stack.append((aliases[current], tainted))
        if current in call_bindings and current not in bodies:
            for target in call_bindings[current]:
                stack.append((target, frozenset()))
        if current not in bodies:
            continue
        lo, hi, params = bodies[current]
        shadowed = _shadows(toks, lo, hi, params, helper_names, aliases)
        helper, names, recipients, calls = _scan_body(
            toks, text, lo, hi, bodies, helper_names, tainted, shadowed
        )
        if helper:
            return True
        for callee, args in calls:
            if callee not in bodies:
                continue
            cparams = bodies[callee][2]
            passed: set[str] = set()
            for idx, arg in enumerate(args):
                if arg is None or idx >= len(cparams):
                    continue
                if arg in tainted or (arg in helper_names and arg not in shadowed):
                    passed.add(cparams[idx])
            if passed:
                stack.append((callee, frozenset(passed)))
        for local in names:
            if local in bodies or local in call_bindings or local in aliases:
                stack.append((local, frozenset()))
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
        if path.suffix not in {".ts", ".tsx", ".js", ".jsx", ".mts"}:
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
