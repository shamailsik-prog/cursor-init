#!/usr/bin/env python3
"""permission-action parity guard (audit FA-F43-R1-P01; G-0 check [23]).

The shared P5 table (platform/p5/permissionDecision.ts `decide`) ends in `deny("unknown-action")`: an action no row
knows is refused. This guard keeps every action a call site passes into P5 in that table, so a new or renamed action is
caught at build time instead of being refused at run time (spec
docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md, ruling R9).

The table: `DECIDE_ACTIONS` in platform/p5/permissionDecision.ts, an `as const` list of string literals and spreads of
the file's other `as const` lists. Its type aliases (`export type D1Action = (typeof D1_ACTIONS)[number]`, `export type
CommitteeBrainAction = "committee_brain" | "committee_brain_read"`) resolve typed parameters.

The entry points (ENTRY_POINTS) and the argument that carries the action:
  - `checkPermission` of platform/p5/checkPermission (Next.js): argument 3;
  - `decide` of platform/p5/permissionDecision: argument 2;
  - `checkPermission` and `requirePermission` of functions/src/p5/permission (Cloud Functions): argument 2.
Imports resolve by path (the `@/` alias, relative, a bare repository path; with or without a JS/TS extension or `/index`),
`as` aliases included. The defining module's own calls count.

Tokens come from ci_gates/js_lexer.py, the lexer G-0 [21] reads with (comments dropped; identifiers and string literals
decoded, so an escape spelling such as `check\\u0050ermission` or `"rese\\u0061rch"` is read as the engine reads it).

Scope: every JS/TS file the G-0 walker yields (g0_guard_common.iter_scan_files: root tests/ and ci_gates/ are skipped)
except functions/test/ and functions/lib/; the tests pass unknown actions on purpose. A file is read only when its text
holds "ermission" (every entry specifier and name does).

An action argument passes when it is:
  - a plain string literal ('…' or "…") that is in DECIDE_ACTIONS; or
  - an identifier whose nearest preceding declaration in the file (a `const` / `let` / `var`, or a parameter of a function
    or arrow function) carries a type annotation that is a union of string literals and of the table's type aliases,
    every member of which is in DECIDE_ACTIONS (TypeScript then holds every caller of that function to the same set); or
  - a computed site listed in LISTED (the P5 entry points forwarding their own caller's action).

It fails on:
  - `unknown_action`: a literal, or a member of a resolved type, that DECIDE_ACTIONS does not hold;
  - `template_action`: a template literal (write a plain string literal);
  - `computed_action`: an identifier with no resolvable annotation (untyped, `string`, a local type), a member expression,
    a call, a conditional, a concatenation, a spread before or at the action argument, anything else;
  - `missing_action`: a call with fewer arguments than the action's position;
  - `untracked_binding`: a namespace or default import, an `export *` / `export * as`, a re-export of an entry name, an
    `import()` or `require()` of an entry module: the names it reaches cannot be followed;
  - `escaped_reference`: an entry name used other than as a call (`const f = checkPermission`, `.filter(checkPermission)`,
    `{ checkPermission }`, `export default checkPermission`); `typeof checkPermission` (a type query) is allowed;
  - `stale_listing`: a LISTED site that no longer exists;
  - `no_table`: the table file or its DECIDE_ACTIONS list is missing.

`--print-known` prints DECIDE_ACTIONS as parsed (tests/fa-f43-p01-permission-actions-gate.test.ts compares it with the
TypeScript list); `--print-inventory` prints every call site with its resolved actions; `--root` scans another tree.

Residuals (spec section 5): the nearest preceding declaration is found by position, not by scope, so a shadowing
declaration in a nested scope is not modelled; JSX text is tokenized as code (no .tsx file calls an entry point today);
a cast at a typed wrapper's call site passes. At run time `decide` refuses any action no row knows, whatever this gate
missed.
"""
from __future__ import annotations

import argparse
import bisect
import json
import pathlib
import posixpath
import re
import sys
from dataclasses import dataclass

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from g0_guard_common import JS_SUFFIXES, iter_scan_files, read_text  # noqa: E402
from js_lexer import lex  # noqa: E402

TABLE = "platform/p5/permissionDecision.ts"
TABLE_MODULE = "platform/p5/permissionDecision"
DECIDE_LIST = "DECIDE_ACTIONS"

# module path (no extension) -> { exported entry name: 0-based index of the action argument }
ENTRY_POINTS: dict[str, dict[str, int]] = {
    "platform/p5/checkPermission": {"checkPermission": 2},
    TABLE_MODULE: {"decide": 1},
    "functions/src/p5/permission": {"checkPermission": 1, "requirePermission": 1},
}

# (file, local callee name, argument text) -> why the computed action is accepted
LISTED: dict[tuple[str, str, str], str] = {
    ("platform/p5/checkPermission.ts", "decideFromTable", "action"): (
        "the Next.js P5 entry point: checkPermission forwards its own caller's action, and every checkPermission call "
        "site is checked by this gate"
    ),
    ("functions/src/p5/permission.ts", "decide", "action"): (
        "the Cloud Functions P5 entry point: evaluate forwards checkPermission's action, and every checkPermission and "
        "requirePermission call site is checked by this gate"
    ),
}

EXCLUDED_PREFIXES = ("functions/test/", "functions/lib/")

_JS_EXT_RE = re.compile(r"\.(?:[cm]?[jt]sx?)$", re.I)


@dataclass(frozen=True)
class Finding:
    rel: str
    line: int
    kind: str
    detail: str

    def __str__(self) -> str:
        return f"{self.rel}:{self.line}: {self.kind}: {self.detail}"


# --- tokenizer ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Tok:
    kind: str  # id | str | num | punct | regex | priv | tpl | tplend
    text: str  # identifier, punctuation, or a string literal's value (decoded)
    pos: int


def tokenize(text: str) -> list[Tok]:
    """The tokens of JS/TS source, read by ci_gates/js_lexer.py (the lexer G-0 [21] reads with: comments dropped,
    identifiers and string literals decoded, so `check\\u0050ermission` is checkPermission and `"rese\\u0061rch"` is
    research). A template literal becomes `tpl`, each substitution's tokens between `${` and `}`, then `tplend`, so a
    template argument is one bracketed group to this gate's argument split."""
    toks: list[Tok] = []
    for t in lex(text):
        if t.kind != "tpl":
            toks.append(Tok(t.kind, t.value, t.start))
            continue
        if t.part in ("middle", "tail"):
            toks.append(Tok("punct", "}", t.start))
        if t.part in ("full", "head"):
            toks.append(Tok("tpl", "`", t.start))
        if t.part in ("head", "middle"):
            toks.append(Tok("punct", "${", t.end - 2))
        if t.part in ("full", "tail"):
            toks.append(Tok("tplend", "`", t.end - 1))
    return toks


_OPEN = {"(": ")", "[": "]", "{": "}", "${": "}"}
_CLOSE = {")", "]", "}"}


def bracket_structure(toks: list[Tok]) -> tuple[dict[int, int], list[int]]:
    """match[i] for every opener and closer; parent[i] = the innermost unclosed opener before token i (or -1)."""
    match: dict[int, int] = {}
    parent: list[int] = []
    stack: list[int] = []
    for i, t in enumerate(toks):
        parent.append(stack[-1] if stack else -1)
        if t.kind == "punct" and t.text in _OPEN:
            stack.append(i)
        elif t.kind == "punct" and t.text in _CLOSE and stack:
            j = stack.pop()
            match[i] = j
            match[j] = i
    return match, parent


class Lines:
    """1-based line numbers of offsets in one text, indexed once (the route files run to 19,000 lines)."""

    def __init__(self, text: str) -> None:
        self.offsets = [m.start() for m in re.finditer("\n", text)]

    def __call__(self, pos: int) -> int:
        return bisect.bisect_left(self.offsets, pos) + 1


# --- the table ---------------------------------------------------------------------------------------------------


@dataclass
class Table:
    known: list[str]
    known_set: frozenset[str]
    types: dict[str, list[str]]  # exported type alias -> its string values


def _parse_lists(toks: list[Tok]) -> dict[str, list[str]]:
    """`const NAME = [ "a", ...OTHER, "b" ]` (as const or not) -> NAME's values, spreads resolved in file order."""
    lists: dict[str, list[str]] = {}
    for i in range(len(toks) - 3):
        if not (toks[i].kind == "id" and toks[i].text == "const" and toks[i + 1].kind == "id"):
            continue
        name = toks[i + 1].text
        j = i + 2
        if toks[j].kind == "punct" and toks[j].text == ":":
            continue  # an annotated list (`ReadonlySet<string>`, …) is not a table list
        if not (toks[j].kind == "punct" and toks[j].text == "=" and toks[j + 1].kind == "punct" and toks[j + 1].text == "["):
            continue
        k = j + 2
        values: list[str] = []
        ok = True
        while k < len(toks) and not (toks[k].kind == "punct" and toks[k].text == "]"):
            t = toks[k]
            if t.kind == "str":
                values.append(t.text)
            elif t.kind == "punct" and t.text == "...":
                ref = toks[k + 1] if k + 1 < len(toks) else None
                if ref is None or ref.kind != "id" or ref.text not in lists:
                    ok = False
                    break
                values.extend(lists[ref.text])
                k += 1
            elif not (t.kind == "punct" and t.text == ","):
                ok = False
                break
            k += 1
        if ok:
            lists[name] = values
    return lists


def _type_terms(tokens: list[Tok]) -> list[Tok] | None:
    """The union members of a type annotation's tokens: each a string literal or an identifier; None for anything else."""
    terms: list[Tok] = []
    expect_term = True
    for t in tokens:
        if t.kind == "punct" and t.text == "|":
            if expect_term and terms:
                return None
            expect_term = True
            continue
        if not expect_term or t.kind not in {"str", "id"}:
            return None
        terms.append(t)
        expect_term = False
    return terms if terms and not expect_term else None


def _parse_types(toks: list[Tok], lists: dict[str, list[str]]) -> dict[str, list[str]]:
    """`export type X = (typeof LIST)[number]` and `export type X = "a" | "b" | Y` -> X's values."""
    types: dict[str, list[str]] = {}
    for i in range(len(toks) - 3):
        if not (toks[i].kind == "id" and toks[i].text == "type" and toks[i + 1].kind == "id"):
            continue
        if not (toks[i + 2].kind == "punct" and toks[i + 2].text == "="):
            continue
        name = toks[i + 1].text
        k = i + 3
        body: list[Tok] = []
        while k < len(toks) and not (toks[k].kind == "id" and toks[k].text in {"export", "type", "const", "function", "import"}):
            if toks[k].kind == "punct" and toks[k].text == ";":
                break
            body.append(toks[k])
            k += 1
        texts = [t.text for t in body]
        if len(texts) == 7 and texts[0] == "(" and texts[1] == "typeof" and texts[3] == ")" and texts[4:] == ["[", "number", "]"]:
            if texts[2] in lists:
                types[name] = list(lists[texts[2]])
            continue
        terms = _type_terms(body)
        if terms is None:
            continue
        values: list[str] = []
        for t in terms:
            if t.kind == "str":
                values.append(t.text)
            elif t.text in types:
                values.extend(types[t.text])
            else:
                values = []
                break
        if values:
            types[name] = values
    return types


def load_table(root: pathlib.Path) -> Table | None:
    text = read_text(root / TABLE)
    if text is None:
        return None
    toks = tokenize(text)
    lists = _parse_lists(toks)
    if DECIDE_LIST not in lists or not lists[DECIDE_LIST]:
        return None
    known = lists[DECIDE_LIST]
    return Table(known=known, known_set=frozenset(known), types=_parse_types(toks, lists))


def known_actions(root: pathlib.Path) -> list[str]:
    table = load_table(root)
    return list(table.known) if table else []


# --- imports -----------------------------------------------------------------------------------------------------


def module_of(rel: str) -> str:
    p = _JS_EXT_RE.sub("", rel)
    return p[: -len("/index")] if p.endswith("/index") else p


def resolve_specifier(spec: str, rel: str) -> str:
    spec = spec.split("?", 1)[0].split("#", 1)[0]
    if spec.startswith("@/"):
        p = spec[2:]
    elif spec.startswith("."):
        p = posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
    else:
        p = spec
    return module_of(p)


@dataclass
class FileBindings:
    calls: dict[str, tuple[str, int]]  # local name -> (entry module, action index)
    types: dict[str, str]  # local type name -> the table's type name
    skip: set[int]  # token indexes inside import / export-from statements
    findings: list[Finding]


def _named_clause(toks: list[Tok], i: int) -> tuple[list[tuple[str, str, bool]], int]:
    """`{ a, b as c, type d }` from the `{` at i: [(imported, local, type_only)], index after the `}`."""
    out: list[tuple[str, str, bool]] = []
    j = i + 1
    while j < len(toks) and not (toks[j].kind == "punct" and toks[j].text == "}"):
        type_only = False
        if toks[j].kind == "id" and toks[j].text == "type" and j + 1 < len(toks) and toks[j + 1].kind == "id" and toks[j + 1].text not in {"as"}:
            type_only = True
            j += 1
        if toks[j].kind in {"id", "str"}:
            name = toks[j].text
            local = name
            if j + 2 < len(toks) and toks[j + 1].kind == "id" and toks[j + 1].text == "as":
                local = toks[j + 2].text
                j += 2
            out.append((name, local, type_only))
        j += 1
    return out, j + 1


def read_bindings(rel: str, lines: Lines, toks: list[Tok]) -> FileBindings:
    b = FileBindings(calls={}, types={}, skip=set(), findings=[])
    own = module_of(rel)
    if own in ENTRY_POINTS:
        for name, index in ENTRY_POINTS[own].items():
            b.calls[name] = (own, index)
    n = len(toks)
    for i, t in enumerate(toks):
        if t.kind != "id" or t.text not in {"require", "import", "export"}:
            continue
        if i > 0 and toks[i - 1].kind == "punct" and toks[i - 1].text in {".", "?."}:
            continue
        line = lines(t.pos)
        if t.text in {"require", "import"} and i + 2 < n and toks[i + 1].text == "(" and toks[i + 2].kind == "str":
            if resolve_specifier(toks[i + 2].text, rel) in ENTRY_POINTS:
                b.findings.append(Finding(rel, line, "untracked_binding", f"{t.text}() of {toks[i + 2].text}: its names cannot be followed"))
            continue
        if t.text == "require":
            continue
        # A static import, or an export-from: its clause holds only identifiers, `{`, `}`, `,` and `*` up to
        # `from "<spec>"`. Anything else (a declaration, `=`, `(`, another statement's keyword) ends the search.
        j = i + 1
        while j < n:
            tj = toks[j]
            if tj.kind == "id" and tj.text == "from" and j + 1 < n and toks[j + 1].kind == "str":
                break
            if tj.kind == "id" and tj.text in {"import", "export"}:
                break
            if not (tj.kind == "id" or (tj.kind == "punct" and tj.text in {"{", "}", ",", "*"})):
                break
            j += 1
        if not (j + 1 < n and toks[j].kind == "id" and toks[j].text == "from" and toks[j + 1].kind == "str"):
            continue
        spec = toks[j + 1].text
        module = resolve_specifier(spec, rel)
        b.skip.update(range(i, j + 2))
        if module not in ENTRY_POINTS:
            continue
        entries = ENTRY_POINTS[module]
        clause = toks[i + 1 : j]
        if clause and clause[0].kind == "id" and clause[0].text == "type":
            clause = clause[1:]
            clause_type_only = True
        else:
            clause_type_only = False
        k = 0
        while k < len(clause):
            c = clause[k]
            if c.kind == "punct" and c.text == "*":
                b.findings.append(Finding(rel, line, "untracked_binding", f"{t.text} * of {spec}: its names cannot be followed"))
                k += 1
                if k < len(clause) and clause[k].text == "as":
                    k += 2
                continue
            if c.kind == "punct" and c.text == "{":
                names, after = _named_clause(clause, k)
                for name, local, type_only in names:
                    if t.text == "export":
                        if name in entries and not (type_only or clause_type_only):
                            b.findings.append(Finding(rel, line, "untracked_binding", f"re-export of {name} from {spec}: calls through it cannot be followed"))
                        continue
                    if name in entries and not (type_only or clause_type_only):
                        b.calls[local] = (module, entries[name])
                    if module == TABLE_MODULE:
                        b.types[local] = name
                k = after
                continue
            if c.kind == "id" and t.text == "import":
                b.findings.append(Finding(rel, line, "untracked_binding", f"default import {c.text} of {spec}: its names cannot be followed"))
            k += 1
    return b


# --- call sites --------------------------------------------------------------------------------------------------

_DECL_WORDS = frozenset({"const", "let", "var"})
_CONTROL_WORDS = frozenset({"if", "while", "for", "switch", "with", "return", "typeof", "await", "yield"})


def split_args(toks: list[Tok], open_index: int, match: dict[int, int]) -> list[list[Tok]]:
    close = match.get(open_index)
    if close is None:
        return []
    args: list[list[Tok]] = [[]]
    depth = 0
    for t in toks[open_index + 1 : close]:
        if t.kind == "punct" and t.text in _OPEN:
            depth += 1
        elif t.kind == "punct" and t.text in _CLOSE:
            depth -= 1
        elif t.kind == "tpl":
            depth += 1
        elif t.kind == "tplend":
            depth -= 1
        if depth == 0 and t.kind == "punct" and t.text == ",":
            args.append([])
            continue
        args[-1].append(t)
    if args and not args[-1]:
        args.pop()  # a trailing comma
    return args


def _type_tokens(toks: list[Tok], start: int, match: dict[int, int]) -> list[Tok]:
    """The tokens of a type annotation starting at `start`, up to a top-level `,`, `)`, `=` or `;`."""
    out: list[Tok] = []
    j = start
    depth = 0
    while j < len(toks):
        t = toks[j]
        if t.kind == "punct":
            if t.text in _OPEN:
                depth += 1
            elif t.text in _CLOSE:
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0 and t.text in {",", "=", ";"}:
                break
        out.append(t)
        j += 1
    return out


def _is_param_list(toks: list[Tok], opener: int, match: dict[int, int]) -> bool:
    if opener < 0 or toks[opener].text != "(":
        return False
    if opener > 0 and toks[opener - 1].kind == "id" and toks[opener - 1].text in _CONTROL_WORDS:
        return False
    close = match.get(opener)
    if close is None or close + 1 >= len(toks):
        return False
    after = toks[close + 1]
    return after.kind == "punct" and after.text in {"{", "=>", ":"}


def find_declaration(toks: list[Tok], call_index: int, name: str, match: dict[int, int], parent: list[int]) -> tuple[str, list[Tok] | None] | None:
    """The nearest declaration of `name` before `call_index`: ("var" | "param", its annotation's tokens or None)."""
    for j in range(call_index - 1, -1, -1):
        t = toks[j]
        if t.kind != "id" or t.text != name:
            continue
        prev = toks[j - 1] if j > 0 else None
        nxt = toks[j + 1] if j + 1 < len(toks) else None
        if prev is not None and prev.kind == "id" and prev.text in _DECL_WORDS:
            if nxt is not None and nxt.kind == "punct" and nxt.text == ":":
                return "var", _type_tokens(toks, j + 2, match)
            return "var", None
        if prev is not None and prev.kind == "punct" and prev.text in {"(", ","} and _is_param_list(toks, parent[j], match):
            k = j + 1
            if k < len(toks) and toks[k].kind == "punct" and toks[k].text == "?":
                k += 1
            if k < len(toks) and toks[k].kind == "punct" and toks[k].text == ":":
                return "param", _type_tokens(toks, k + 1, match)
            return "param", None
    return None


def resolve_type(type_toks: list[Tok], table: Table, types: dict[str, str], own_table: bool) -> list[str] | None:
    terms = _type_terms(type_toks)
    if terms is None:
        return None
    values: list[str] = []
    for t in terms:
        if t.kind == "str":
            values.append(t.text)
            continue
        original = types.get(t.text) or (t.text if own_table else None)
        if original is None or original not in table.types:
            return None
        values.extend(table.types[original])
    return values


def scan_file(rel: str, text: str, table: Table, used: set[tuple[str, str, str]], rows: list[dict]) -> list[Finding]:
    toks = tokenize(text)
    lines = Lines(text)
    b = read_bindings(rel, lines, toks)
    findings = list(b.findings)
    if not b.calls:
        return findings
    match, parent = bracket_structure(toks)
    own_table = module_of(rel) == TABLE_MODULE
    n = len(toks)
    for i, t in enumerate(toks):
        if t.kind != "id" or t.text not in b.calls or i in b.skip:
            continue
        prev = toks[i - 1] if i > 0 else None
        nxt = toks[i + 1] if i + 1 < n else None
        if prev is not None and prev.kind == "punct" and prev.text in {".", "?."}:
            continue  # a property of something else
        if prev is not None and prev.kind == "id" and prev.text in {"function", "typeof"}:
            continue  # its definition, or a type query
        if prev is not None and prev.kind == "punct" and prev.text in {"{", ","} and nxt is not None and nxt.kind == "punct" and nxt.text == ":":
            continue  # an object key of the same spelling
        line = lines(t.pos)
        open_index = i + 1
        if nxt is not None and nxt.kind == "punct" and nxt.text == "?." and i + 2 < n and toks[i + 2].text == "(":
            open_index = i + 2
        if not (open_index < n and toks[open_index].kind == "punct" and toks[open_index].text == "("):
            findings.append(Finding(rel, line, "escaped_reference", f"{t.text} is used other than as a call: the action it is given cannot be followed"))
            continue
        module, index = b.calls[t.text]
        args = split_args(toks, open_index, match)
        if any(a and a[0].kind == "punct" and a[0].text == "..." for a in args[: index + 1]):
            findings.append(Finding(rel, line, "computed_action", f"{t.text}(...) spreads its arguments: the action cannot be read"))
            continue
        if len(args) <= index:
            findings.append(Finding(rel, line, "missing_action", f"{t.text} is called with {len(args)} argument(s); the action is argument {index + 1}"))
            continue
        arg = args[index]
        arg_text = " ".join(x.text for x in arg)
        row = {"file": rel, "line": line, "callee": t.text, "entry": module, "actions": [], "how": ""}
        if len(arg) == 1 and arg[0].kind == "str":
            action = arg[0].text
            if action not in table.known_set:
                findings.append(Finding(rel, line, "unknown_action", f"{t.text}(… {json.dumps(action)} …): not in {DECIDE_LIST}"))
                continue
            row.update(actions=[action], how="literal")
            rows.append(row)
            continue
        if arg and arg[0].kind == "tpl":
            findings.append(Finding(rel, line, "template_action", f"{t.text} is given a template literal: write the action as a plain string literal"))
            continue
        key = (rel, t.text, arg_text)
        if key in LISTED:
            used.add(key)
            row.update(actions=["*"], how="listed")
            rows.append(row)
            continue
        if len(arg) == 1 and arg[0].kind == "id" and arg[0].text not in {"undefined", "null", "true", "false", "this"}:
            decl = find_declaration(toks, i, arg[0].text, match, parent)
            if decl is None or decl[1] is None:
                what = "has no declaration in this file" if decl is None else "is declared without a type"
                findings.append(Finding(rel, line, "computed_action", f"{t.text} is given {arg_text}, which {what}: the action cannot be resolved"))
                continue
            values = resolve_type(decl[1], table, b.types, own_table)
            if values is None:
                type_text = " ".join(x.text for x in decl[1])
                findings.append(Finding(rel, line, "computed_action", f"{t.text} is given {arg_text}: {type_text}, which is not a union of string literals or of the table's action types"))
                continue
            unknown = [v for v in values if v not in table.known_set]
            if unknown:
                findings.append(Finding(rel, line, "unknown_action", f"{t.text} is given {arg_text}, whose type admits {', '.join(json.dumps(v) for v in unknown)}: not in {DECIDE_LIST}"))
                continue
            row.update(actions=sorted(set(values)), how="typed")
            rows.append(row)
            continue
        findings.append(Finding(rel, line, "computed_action", f"{t.text} is given `{arg_text}`: the action cannot be resolved statically"))
    return findings


def _scan(root: pathlib.Path, listed: dict[tuple[str, str, str], str] | None = None) -> tuple[list[Finding], list[dict]]:
    global LISTED
    saved = LISTED
    if listed is not None:
        LISTED = listed
    try:
        table = load_table(root)
        if table is None:
            return [Finding(TABLE, 1, "no_table", f"{TABLE} has no {DECIDE_LIST} list of string literals")], []
        findings: list[Finding] = []
        rows: list[dict] = []
        used: set[tuple[str, str, str]] = set()
        for rel_path in iter_scan_files(root):
            rel = str(rel_path).replace("\\", "/")
            if rel_path.suffix.lower() not in JS_SUFFIXES or rel.startswith(EXCLUDED_PREFIXES):
                continue
            text = read_text(root / rel_path)
            if text is None or "ermission" not in text:
                continue
            findings.extend(scan_file(rel, text, table, used, rows))
        for key in sorted(set(LISTED) - used):
            findings.append(Finding(key[0], 1, "stale_listing", f"listed computed site {key[1]}({key[2]}) no longer exists: remove it from LISTED"))
        return findings, rows
    finally:
        LISTED = saved


def scan(root: pathlib.Path, listed: dict[tuple[str, str, str], str] | None = None) -> list[Finding]:
    return _scan(root, listed)[0]


def inventory(root: pathlib.Path) -> list[dict]:
    return _scan(root)[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default=".", help="tree to scan (default: the current directory)")
    parser.add_argument("--print-known", action="store_true", help="print DECIDE_ACTIONS as parsed, as JSON")
    parser.add_argument("--print-inventory", action="store_true", help="print every call site and its actions, as JSON")
    args = parser.parse_args(argv)
    root = pathlib.Path(args.root)
    if args.print_known:
        print(json.dumps(known_actions(root)))
        return 0
    findings, rows = _scan(root)
    if args.print_inventory:
        print(json.dumps(rows, indent=1))
        return 0
    if findings:
        for f in findings:
            print(f"FAIL: {f}")
        print(f"FAIL: permission-action parity ({len(findings)} finding(s)); spec docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md R9")
        return 1
    literal = sum(1 for r in rows if r["how"] == "literal")
    typed = sum(1 for r in rows if r["how"] == "typed")
    listed_count = sum(1 for r in rows if r["how"] == "listed")
    print(f"PASS permission-action parity: {len(rows)} call sites ({literal} literal, {typed} typed, {listed_count} listed entry forwards), {len(known_actions(root))} table actions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
