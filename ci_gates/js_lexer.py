#!/usr/bin/env python3
"""A small JavaScript/TypeScript lexer for the G-0 guards (audit F34 round 2, FA-F34-R2-001; spec R31).

Pure Python, because G-0 runs before `node_modules` exists (CI job "Gates G-0, G-1, G-2": the "Gate G-0 static" step runs
`G0_STATIC_ONLY=1 bash ci_gates/gate_g0.sh` before "Install"; the one TypeScript-compiler check, F18 [19](f), runs as a
separate step after it). It is not a parser. It reads the token stream the way the language defines it, so a guard that
reads tokens is not fooled by what a regular expression over the raw text cannot see:

- comments are dropped (a line break inside one still counts for automatic semicolon insertion);
- an identifier is decoded (`activ\\u0065Transport` is `activeTransport`, as the engine binds it);
- a string literal is decoded (`"./trans\\u0070ort"` is `"./transport"`, `\\x74` is `t`, `\\u{6f}` is `o`, a line
  continuation is nothing), and so is each chunk of a template literal;
- the text inside string, template and regular-expression literals is never read as code.

A `/` starts a regular expression where an expression may start (after an operator, an opening bracket, a keyword such as
`return`, or at the start), and is division after an identifier, a literal, `)` or `]`. A `}` is read as the end of a block,
so a `/` after it starts a regular expression; JavaScript itself needs the parse to decide, and the rare division after an
object literal is read as a regular expression up to the end of its line. A string that reaches a line break unclosed ends
there. Neither case can join two lines of code.

`lex(text)` returns the tokens; ci_gates/check_p1_transport_imports.py reads them (G-0 [21]).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

LINE_TERMINATORS = "\n\r\u2028\u2029"

# Longest first.
_PUNCTUATORS = sorted(
    """>>>= ... === !== **= <<= >>= >>> &&= ||= ??= => == != <= >= && || ?? ?. ++ -- += -= *= /= %= &= |= ^= << >> **
    { } ( ) [ ] ; , < > + - * / % & | ^ ! ~ ? : = . @ #""".split(),
    key=len,
    reverse=True,
)
_PUNCT_RE = re.compile("|".join(re.escape(p) for p in _PUNCTUATORS))
_WS_RE = re.compile(r"[ \t\f\v\u00a0\ufeff\u1680\u2000-\u200a\u202f\u205f\u3000]+")
_NL_RE = re.compile(r"[\n\r\u2028\u2029]+")
_ASCII_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUMBER_RE = re.compile(r"0[xXoObB][0-9A-Fa-f_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?")
_ESCAPE_U_RE = re.compile(r"\\u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))")

# After one of these keywords an expression starts, so `/` opens a regular expression.
REGEX_AFTER_KEYWORDS = frozenset(
    {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends"}
)


@dataclass(frozen=True)
class Tok:
    """One token. `kind`: id (identifier or keyword, decoded), str ('...' or "...", `value` decoded), tpl (a template
    chunk, `value` decoded, `part` full / head / middle / tail), num, regex (`value` is the source), punct, priv (#name).
    `nl`: a line terminator lies between this token and the one before it. `escaped`: the source spelt it with escapes."""

    kind: str
    value: str
    start: int
    end: int
    nl: bool
    part: str = ""
    escaped: bool = False


def _id_start(c: str) -> bool:
    return c.isascii() and (c.isalpha() or c in "_$") or (not c.isascii() and c.isidentifier())


def _id_part(c: str) -> bool:
    if c.isascii():
        return c.isalnum() or c in "_$"
    return ("a" + c).isidentifier() or c in "\u200c\u200d"


def _decode_escape(text: str, i: int) -> tuple[str, int]:
    """The character(s) an escape at text[i] == '\\' stands for in a string or template, and the index after it."""
    n = len(text)
    if i + 1 >= n:
        return "", n
    c = text[i + 1]
    simple = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v"}
    if c in simple:
        return simple[c], i + 2
    if c == "\r":
        return "", i + 3 if text.startswith("\r\n", i + 1) else i + 2
    if c in "\n\u2028\u2029":
        return "", i + 2
    if c == "x":
        m = re.match(r"[0-9A-Fa-f]{2}", text[i + 2 : i + 4])
        if m:
            return chr(int(m.group(0), 16)), i + 4
        return "x", i + 2
    if c == "u":
        m = _ESCAPE_U_RE.match(text, i)
        if m:
            cp = int(m.group(1) or m.group(2), 16)
            return (chr(cp) if cp <= 0x10FFFF else ""), m.end()
        return "u", i + 2
    if c in "01234567":
        m = re.match(r"[0-7]{1,3}", text[i + 1 : i + 4])
        digits = m.group(0) if m else c
        if int(digits, 8) > 0o377:
            digits = digits[:2]
        return chr(int(digits, 8)), i + 1 + len(digits)
    return c, i + 2


def _read_ident(text: str, i: int) -> tuple[str, int, bool] | None:
    """An identifier at text[i], decoded, with the index after it and whether it had escapes; None if none starts here."""
    n = len(text)
    out: list[str] = []
    escaped = False
    j = i
    while j < n:
        c = text[j]
        if c == "\\":
            m = _ESCAPE_U_RE.match(text, j)
            if not m:
                break
            cp = int(m.group(1) or m.group(2), 16)
            ch = chr(cp) if cp <= 0x10FFFF else ""
            if not ch or not (_id_start(ch) if not out else _id_part(ch)):
                break
            out.append(ch)
            escaped = True
            j = m.end()
            continue
        if (_id_start(c) if not out else _id_part(c)):
            out.append(c)
            j += 1
            continue
        break
    if not out:
        return None
    return "".join(out), j, escaped


def _regex_allowed(prev: Tok | None) -> bool:
    if prev is None:
        return True
    if prev.kind == "id":
        return prev.value in REGEX_AFTER_KEYWORDS
    if prev.kind in ("num", "str", "regex", "priv"):
        return False
    if prev.kind == "tpl":
        return prev.part not in ("full", "tail")
    return prev.value not in (")", "]", "++", "--")


def _scan_regex(text: str, i: int) -> int:
    """The index after a regular-expression literal starting at text[i] == '/'; a literal never spans a line break."""
    n = len(text)
    j = i + 1
    in_class = False
    while j < n:
        c = text[j]
        if c in LINE_TERMINATORS:
            return j
        if c == "\\":
            j += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
        elif c == "[":
            in_class = True
        elif c == "/":
            j += 1
            while j < n and _id_part(text[j]):
                j += 1
            return j
        j += 1
    return n


def _scan_string(text: str, i: int) -> tuple[str, int]:
    """A '...' or "..." literal at text[i]: its decoded value and the index after it (an unclosed one ends at the line)."""
    q = text[i]
    n = len(text)
    out: list[str] = []
    j = i + 1
    while j < n:
        c = text[j]
        if c == q:
            return "".join(out), j + 1
        if c == "\\":
            s, j = _decode_escape(text, j)
            out.append(s)
            continue
        if c in "\n\r":
            return "".join(out), j
        out.append(c)
        j += 1
    return "".join(out), n


def _scan_template_chunk(text: str, i: int) -> tuple[str, int, bool]:
    """A template chunk from text[i] (just after ` or the } that ends a substitution): its decoded value, the index after
    it, and whether it ended at `${` (True) or at the closing backtick (False)."""
    n = len(text)
    out: list[str] = []
    j = i
    while j < n:
        c = text[j]
        if c == "`":
            return "".join(out), j + 1, False
        if c == "\\":
            s, j = _decode_escape(text, j)
            out.append(s)
            continue
        if c == "$" and text.startswith("${", j):
            return "".join(out), j + 2, True
        out.append(c)
        j += 1
    return "".join(out), n, False


def lex(text: str) -> list[Tok]:
    toks: list[Tok] = []
    n = len(text)
    i = 0
    nl = False
    # What each open `{` or `${` is, so a `}` that ends a substitution resumes the template.
    braces: list[str] = []
    if text.startswith("#!"):
        j = text.find("\n")
        i = n if j < 0 else j
    while i < n:
        c = text[i]
        m = _WS_RE.match(text, i)
        if m:
            i = m.end()
            continue
        m = _NL_RE.match(text, i)
        if m:
            nl = True
            i = m.end()
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = i + 2
            while j < n and text[j] not in LINE_TERMINATORS:
                j += 1
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            if any(ch in LINE_TERMINATORS for ch in text[i:j]):
                nl = True
            i = j
            continue
        prev = toks[-1] if toks else None
        if c in "'\"":
            value, j = _scan_string(text, i)
            toks.append(Tok("str", value, i, j, nl))
        elif c == "`":
            value, j, opened = _scan_template_chunk(text, i + 1)
            if opened:
                braces.append("${")
            toks.append(Tok("tpl", value, i, j, nl, "head" if opened else "full"))
        elif c == "}" and braces and braces[-1] == "${":
            braces.pop()
            value, j, opened = _scan_template_chunk(text, i + 1)
            if opened:
                braces.append("${")
            toks.append(Tok("tpl", value, i, j, nl, "middle" if opened else "tail"))
        elif c == "/" and _regex_allowed(prev):
            j = _scan_regex(text, i)
            toks.append(Tok("regex", text[i:j], i, j, nl))
        elif c.isdigit() or (c == "." and i + 1 < n and text[i + 1].isdigit()):
            m = _NUMBER_RE.match(text, i)
            j = m.end() if m else i + 1
            while j < n and _id_part(text[j]):
                j += 1
            toks.append(Tok("num", text[i:j], i, j, nl))
        elif c == "#" and i + 1 < n and (_id_start(text[i + 1]) or text[i + 1] == "\\"):
            ident = _read_ident(text, i + 1)
            if ident is None:
                toks.append(Tok("punct", "#", i, i + 1, nl))
                j = i + 1
            else:
                toks.append(Tok("priv", ident[0], i, ident[1], nl, escaped=ident[2]))
                j = ident[1]
        else:
            m = _ASCII_IDENT_RE.match(text, i)
            if m and (m.end() >= n or (text[m.end()] != "\\" and text[m.end()].isascii())):
                j = m.end()
                toks.append(Tok("id", m.group(0), i, j, nl))
            else:
                ident = _read_ident(text, i)
                if ident is not None:
                    j = ident[1]
                    toks.append(Tok("id", ident[0], i, j, nl, escaped=ident[2]))
                else:
                    m = _PUNCT_RE.match(text, i)
                    if m:
                        p = m.group(0)
                        # `?.` followed by a digit is a conditional and a number (`a?.5:b`).
                        if p == "?." and i + 2 < n and text[i + 2].isdigit():
                            p = "?"
                        j = i + len(p)
                        if p == "{":
                            braces.append("{")
                        elif p == "}" and braces:
                            braces.pop()
                        toks.append(Tok("punct", p, i, j, nl))
                    else:
                        j = i + 1
                        toks.append(Tok("punct", c, i, j, nl))
        nl = False
        i = j
    return toks
