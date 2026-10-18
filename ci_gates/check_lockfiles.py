#!/usr/bin/env python3
"""Audit F39 (spec docs/superpowers/specs/2026-10-18-f39-frozen-install-design.md, ruling 3): the frozen-install guard.

A clean CI runner or contributor must be able to run `npm ci` from the checked-in manifests. This guard fails when a
lockfile drifts from its package.json, when npm is not pinned, when an install surface installs without the lockfile,
and (with --npm-ci) when the pinned npm's own `npm ci` validator rejects a lockfile.

Static checks (Gate G-0 check [18]; offline):
  1. The root has package.json and a lockfile, whatever it declares (npm ci fails without one). Every lockfile has a
     package.json beside it, and every package.json that declares dependencies or overrides has a lockfile beside it.
     A directory with both npm-shrinkwrap.json and package-lock.json fails (npm ci uses the shrinkwrap and ignores the
     other); a shrinkwrap on its own is the lockfile checked. yarn/pnpm/bun lockfiles fail: the pinned package
     manager is npm.
  2. Each lockfile is lockfileVersion 3 with a root entry (packages[""]).
  3. The root entry equals the manifest for every field npm copies into it (name, version, the dependency maps,
     engines, os, cpu, workspaces); an empty map or list counts as absent. npm never writes `overrides` into a
     lockfile, so override drift is left to check 8.
  4. Every direct dependency has a node_modules/<name> entry in the lockfile.
  5. Every manifest with a lockfile pins npm: packageManager "npm@X.Y.Z" and devEngines.packageManager
     {name "npm", version "~X.Y.Z" or "X.Y.Z", onFail "warn" or "error"}, packageManager inside that range, one pin
     for all. Ruling R3d chose "warn": npm warns outside the pin, and check 7 enforces it where the guard runs (CI).
  6. No install surface (.github/workflows/*.yml|yaml, .cursor/environment.json, .claude/hooks/*, package.json
     scripts) runs a non-frozen npm command (install and its aliases, install-test, update, uninstall, dedupe; a
     global install is allowed) or skips the lockfile (--package-lock=false, --no-package-lock), and every directory
     a surface runs `npm ci` in holds a package.json and a lockfile. Commands are read with a POSIX shell lexer
     (shlex), so quotes group words and never end a command; a quoted string that is itself shell (bash -c "...") is
     read too; a line that mentions npm but cannot be lexed fails closed. The `npm ci` target is the --prefix / -C
     value, read against the working directory: a workflow step's working-directory, then any `cd` before it in the
     same run script (a package script starts in its own package). A target that cannot be read (a variable, a cd to
     an absolute or computed path, a job-level default working-directory) fails closed unless
     ci_gates/lockfile_install_allowlist.json vouches for that command on that surface; the vouched directories are
     then checked, and an entry that matches nothing fails as stale. Full-line comments are skipped.
Dynamic checks (--npm-ci):
  7. The npm that runs (`npm --version`, or --npm CMD) is inside the pin.
  8. `npm ci --dry-run --ignore-scripts --no-audit --no-fund --prefix <dir>` exits 0 for every lockfile directory: npm's
     own validator, the one `npm ci` runs before it installs (overrides, missing or invalid entries, devEngines).

The walk skips node_modules, .git, .next, .stryker-tmp, .eve, .vercel, .turbo and fixtures directories, and any nested
repository or git worktree (a directory holding its own .git). It fails closed: a missing root manifest or lockfile,
a file that is not JSON, or an npm whose version cannot be read is a failure.

Usage: python3 ci_gates/check_lockfiles.py [--root DIR] [--npm-ci] [--npm CMD]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

LOCK_NAMES = ("package-lock.json", "npm-shrinkwrap.json")
FOREIGN_LOCKS = frozenset({"yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"})
SKIP_DIRS = frozenset({"node_modules", ".git", ".next", ".stryker-tmp", ".eve", ".vercel", ".turbo", "fixtures"})
LOCKFILE_VERSION = 3

# The manifest fields npm copies into the lockfile's root entry (@npmcli/arborist shrinkwrap.js pkgMetaKeys plus
# devDependencies for the top node), less those that do not change what is installed (license, funding, bin, ...).
ROOT_ENTRY_FIELDS = (
    "name",
    "version",
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundleDependencies",
    "engines",
    "os",
    "cpu",
    "workspaces",
)
INSTALLED_DEP_FIELDS = ("dependencies", "devDependencies", "optionalDependencies")
DECLARING_FIELDS = INSTALLED_DEP_FIELDS + ("peerDependencies", "overrides")

PACKAGE_MANAGER_RE = re.compile(r"^npm@(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$")
PIN_RANGE_RE = re.compile(r"^(~?)(\d+)\.(\d+)\.(\d+)$")
# Ruling R3d: npm warns outside the pin ("warn", the policy) or refuses ("error"); "ignore" or nothing is no pin.
ON_FAIL_ALLOWED = ("warn", "error")

# npm 10 commands that install without the lockfile or rewrite it, with their aliases (npm lib/utils/cmd-list.js).
NON_FROZEN = frozenset(
    {
        "install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall",
        "install-test", "it",
        "update", "up", "upgrade", "udpate",
        "uninstall", "un", "unlink", "remove", "rm", "r",
        "dedupe", "ddp",
    }
)
# `npm ci` and its aliases (npm lib/utils/cmd-list.js), including install-ci-test, which runs ci first.
CI_COMMANDS = frozenset(
    {"ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-ci-test", "cit", "clean-install-test", "sit"}
)
# npm options that take a separate value, so the value is not read as the subcommand.
VALUE_OPTIONS = frozenset(
    {
        "--prefix", "-C", "--cache", "--registry", "--userconfig", "--globalconfig", "--loglevel", "-w",
        "--workspace", "--omit", "--include", "--install-strategy", "--location", "--script-shell", "--tag",
        "--otp", "--scope", "--node-options", "--cpu", "--os", "--libc",
    }
)
# Review round 2 (Copilot, thread 4305283954): commands are read with a shell lexer (shlex, POSIX rules), so a quote
# never ends a command early. A run of `();<>|&` is one operator token; `<` or `>` in it is a redirection.
SHELL_OPERATOR_RE = re.compile(r"^[();<>|&]+$")
# A text worth reading as shell: it mentions npm, or it changes directory.
NPM_RE = re.compile(r"\bnpm\b")
CD_RE = re.compile(r"(?:^|[\s;&|(])cd\b")
# The npm executable as a word: npm, a path ending in /npm, or npm@<version> run through npx or corepack.
NPM_WORD_RE = re.compile(r"^(?:.*/)?npm(?:@[\w.^~+-]+)?$")
# `cd` to these is a cd to the repository root.
ROOT_CD_TARGETS = frozenset({"$(git rev-parse --show-toplevel)", "`git rev-parse --show-toplevel`"})
# A target the guard cannot read without running a shell: a variable, a command substitution, a glob or a home path.
UNREADABLE_PATH_RE = re.compile(r"[$`*?~]")
RUN_KEY_RE = re.compile(r"^(\s*)(-\s+)?run:\s*(.*)$")
WORKING_DIRECTORY_RE = re.compile(r"^(?:-\s+)?working-directory:\s*(.*)$")
# npm ci invocations whose target cannot be read, each vouched for (after review) with the directories it installs.
ALLOWLIST = "ci_gates/lockfile_install_allowlist.json"
LOCK_SKIP_RE = re.compile(r"(?<![\w-])(--package-lock=false|--no-package-lock)(?![\w-])")


class Problems:
    def __init__(self) -> None:
        self.items: list[str] = []

    def add(self, message: str) -> None:
        self.items.append(message)


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def walk(root: Path) -> tuple[list[Path], list[Path], list[Path]]:
    """Every package.json, npm lockfile and foreign lockfile under root, outside skipped and nested trees."""
    manifests: list[Path] = []
    locks: list[Path] = []
    foreign: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and not (here / d / ".git").exists()
        )
        for name in sorted(filenames):
            if name == "package.json":
                manifests.append(here / name)
            elif name in LOCK_NAMES:
                locks.append(here / name)
            elif name in FOREIGN_LOCKS:
                foreign.append(here / name)
    return manifests, locks, foreign


def load_json(root: Path, path: Path, problems: Problems) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as err:
        problems.add(f"{rel(root, path)}: cannot read ({err.strerror})")
        return None
    except ValueError:
        problems.add(f"{rel(root, path)}: not valid JSON")
        return None
    if not isinstance(data, dict):
        problems.add(f"{rel(root, path)}: not a JSON object")
        return None
    return data


def empty(value: object) -> bool:
    return value is None or (isinstance(value, (dict, list)) and not value)


def show(value: object) -> str:
    return "(absent)" if empty(value) else json.dumps(value, sort_keys=True)


def manifest_field(manifest: dict, field: str) -> object:
    if field == "bundleDependencies" and "bundleDependencies" not in manifest:
        return manifest.get("bundledDependencies")
    return manifest.get(field)


def declares_dependencies(manifest: dict) -> bool:
    return any(not empty(manifest.get(field)) for field in DECLARING_FIELDS)


def compare_root_entry(root: Path, lock_path: Path, manifest_path: Path, manifest: dict, entry: dict, problems: Problems) -> None:
    lock_rel, manifest_rel = rel(root, lock_path), rel(root, manifest_path)
    for field in ROOT_ENTRY_FIELDS:
        want = manifest_field(manifest, field)
        have = entry.get(field)
        if empty(want) and empty(have):
            continue
        if isinstance(want, dict) or isinstance(have, dict):
            want_map = want if isinstance(want, dict) else {}
            have_map = have if isinstance(have, dict) else {}
            if (want is not None and not isinstance(want, dict)) or (have is not None and not isinstance(have, dict)):
                problems.add(
                    f"{lock_rel}: root entry {field} is {show(have)} but {manifest_rel} says {show(want)} "
                    "(regenerate the lock with the pinned npm)"
                )
                continue
            for key in sorted(set(want_map) | set(have_map)):
                if want_map.get(key) != have_map.get(key):
                    problems.add(
                        f"{lock_rel}: root entry {field}.{key} is {show(have_map.get(key))} but {manifest_rel} says "
                        f"{show(want_map.get(key))} (regenerate the lock with the pinned npm)"
                    )
        elif want != have:
            problems.add(
                f"{lock_rel}: root entry {field} is {show(have)} but {manifest_rel} says {show(want)} "
                "(regenerate the lock with the pinned npm)"
            )


def check_lock(root: Path, lock_path: Path, manifest_path: Path, problems: Problems) -> bool:
    """Checks 2-4 for one pair. True when the pair is consistent."""
    before = len(problems.items)
    lock = load_json(root, lock_path, problems)
    manifest = load_json(root, manifest_path, problems)
    if lock is None or manifest is None:
        return False
    lock_rel = rel(root, lock_path)
    version = lock.get("lockfileVersion")
    if version != LOCKFILE_VERSION:
        problems.add(f"{lock_rel}: lockfileVersion {version}, expected {LOCKFILE_VERSION} (regenerate it with the pinned npm)")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        problems.add(f'{lock_rel}: no root entry (packages[""])')
        return False
    compare_root_entry(root, lock_path, manifest_path, manifest, packages[""], problems)
    for field in INSTALLED_DEP_FIELDS:
        for name in sorted(manifest.get(field) or {}):
            if f"node_modules/{name}" not in packages:
                problems.add(f"{lock_rel}: {field}.{name} has no node_modules/{name} entry")
    return len(problems.items) == before


def parse_pin(root: Path, manifest_path: Path, manifest: dict, problems: Problems) -> tuple[str, str] | None:
    """Check 5 for one manifest: (packageManager, devEngines range), or None after recording why not."""
    where = rel(root, manifest_path)
    ok = True
    package_manager = manifest.get("packageManager")
    pm = PACKAGE_MANAGER_RE.match(package_manager) if isinstance(package_manager, str) else None
    if package_manager is None:
        problems.add(f"{where}: no packageManager (expected npm@X.Y.Z)")
        ok = False
    elif pm is None:
        problems.add(f"{where}: packageManager {json.dumps(package_manager)} is not npm@X.Y.Z")
        ok = False
    dev_engines = manifest.get("devEngines")
    pin = dev_engines.get("packageManager") if isinstance(dev_engines, dict) else None
    if not isinstance(pin, dict):
        problems.add(f"{where}: no devEngines.packageManager pin")
        return None
    if pin.get("name") != "npm":
        problems.add(f'{where}: devEngines.packageManager.name is {json.dumps(pin.get("name"))}, expected "npm"')
        ok = False
    # Ruling R3d: "warn" is the policy (npm >= 10.9 warns, CI enforces the pin through --npm-ci); "error" is accepted.
    if pin.get("onFail") not in ON_FAIL_ALLOWED:
        problems.add(f'{where}: devEngines.packageManager.onFail is {json.dumps(pin.get("onFail"))}, expected "warn" or "error"')
        ok = False
    version_range = pin.get("version")
    match = PIN_RANGE_RE.match(version_range) if isinstance(version_range, str) else None
    if match is None:
        problems.add(f"{where}: devEngines.packageManager.version {json.dumps(version_range)} is not a pin (use ~X.Y.0 or X.Y.Z)")
        return None
    if pm is not None and not in_range(tuple(int(g) for g in pm.groups()), version_range):
        problems.add(f"{where}: packageManager {package_manager} is outside devEngines.packageManager.version {version_range}")
        ok = False
    return (package_manager, version_range) if ok else None


def in_range(version: tuple[int, ...], version_range: str) -> bool:
    """`version` (major, minor, patch) against a pin: "~X.Y.Z" (>= X.Y.Z, < X.(Y+1).0) or exact "X.Y.Z"."""
    match = PIN_RANGE_RE.match(version_range)
    if match is None:
        return False
    tilde, major, minor, patch = match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))
    if not tilde:
        return version == (major, minor, patch)
    return version[:2] == (major, minor) and version[2] >= patch


Cwd = tuple  # (directory relative to the root, or None when unknown; why it is unknown)
ROOT_CWD: Cwd = (".", "")


def shell_words(text: str) -> list[str]:
    """Words and operators of `text` under POSIX shell quoting. Quotes group, they never end a command; an unbalanced
    quote raises ValueError."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def split_commands(words: list[str]) -> list[tuple[list[str], str]]:
    """(the words of each simple command, the operator after it). Redirections and their targets are dropped."""
    commands: list[tuple[list[str], str]] = []
    current: list[str] = []
    i = 0
    while i < len(words):
        word = words[i]
        if SHELL_OPERATOR_RE.match(word):
            if "<" in word or ">" in word:
                i += 2
                continue
            commands.append((current, word))
            current = []
        else:
            current.append(word)
        i += 1
    commands.append((current, ""))
    return [(command, operator) for command, operator in commands if command]


def inside(path: str) -> bool:
    return path != ".." and not path.startswith("../")


def cd_into(cwd: Cwd, args: list[str]) -> Cwd:
    target = args[0] if args else "~"
    if target in ROOT_CD_TARGETS:
        return ROOT_CWD
    if target == "-" or UNREADABLE_PATH_RE.search(target) or os.path.isabs(target):
        return (None, f"the working directory comes from cd {target}")
    if cwd[0] is None:
        return cwd
    path = os.path.normpath(os.path.join(cwd[0], target))
    return (path, "") if inside(path) else (None, f"cd {target} leaves the repository")


def npm_subcommand(args: list[str]) -> str | None:
    skip_value = False
    for token in args:
        if skip_value:
            skip_value = False
            continue
        if token.startswith("-"):
            if token in VALUE_OPTIONS:
                skip_value = True
            continue
        return token
    return None


def npm_ci_target(args: list[str], cwd: Cwd) -> Cwd:
    """Where `npm ci <args>` installs: its --prefix / -C value, read against the working directory, else that directory."""
    option = value = None
    for i, token in enumerate(args):
        if token in ("--prefix", "-C"):
            option, value = token, (args[i + 1] if i + 1 < len(args) else "")
        elif token.startswith(("--prefix=", "-C=")):
            option, value = token.split("=", 1)
    if option is None:
        return cwd
    if not value:
        return (None, f"{option} has no value")
    if UNREADABLE_PATH_RE.search(value):
        return (None, f"{option} {value} is held in a variable")
    if os.path.isabs(value):
        return (None, f"{option} {value} is an absolute path")
    if cwd[0] is None:
        return cwd
    path = os.path.normpath(os.path.join(cwd[0], value))
    return (path, "") if inside(path) else (None, f"{option} {value} leaves the repository")


def read_npm(args: list[str], cwd: Cwd, findings: list[tuple]) -> None:
    command = " ".join(["npm", *args])
    subcommand = npm_subcommand(args)
    if subcommand in NON_FROZEN:
        is_global = any(t in ("-g", "--global", "--location=global") for t in args) or any(
            a == "--location" and b == "global" for a, b in zip(args, args[1:])
        )
        if not is_global:
            findings.append(("non_frozen", command))
    elif subcommand in CI_COMMANDS:
        findings.append(("ci", npm_ci_target(args, cwd), command))


def read_shell(text: str, cwd: Cwd, findings: list[tuple], depth: int = 0) -> Cwd:
    """Record every npm command in `text` (and in a quoted string that is itself shell, as in bash -c "...") and follow
    `cd`. Returns the working directory after `text`. A text that mentions npm but cannot be lexed fails closed."""
    if not NPM_RE.search(text) and not CD_RE.search(text):
        return cwd
    try:
        words = shell_words(text.replace("\n", " ; "))
    except ValueError as err:
        if NPM_RE.search(text):
            findings.append(("unreadable", str(err)))
        return (None, "an earlier line could not be read as shell")
    commands = split_commands(words)
    pending_unknown: str | None = None
    for index, (command, operator) in enumerate(commands):
        # `cd A || B`: after B the directory depends on whether cd A succeeded, so it is unknown from then on.
        apply_unknown, pending_unknown = pending_unknown, None
        for word in command:
            if depth < 3 and NPM_RE.search(word) and re.search(r"[\s;&|]", word):
                read_shell(word, cwd, findings, depth + 1)
        if command[0] == "cd":
            cwd = cd_into(cwd, command[1:])
            following = commands[index + 1][0] if index + 1 < len(commands) else []
            if operator == "||" and (not following or following[0] not in ("exit", "return")):
                pending_unknown = cwd[1] or f"cd {' '.join(command[1:2])} may fail over to another command"
        else:
            for position, word in enumerate(command):
                if NPM_WORD_RE.match(word):
                    read_npm(command[position + 1:], cwd, findings)
                    break
        if apply_unknown is not None:
            cwd = (None, apply_unknown)
    if pending_unknown is not None:
        cwd = (None, pending_unknown)
    return cwd


def logical_lines(lines: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Join backslash continuations; each joined line keeps its first line number."""
    joined: list[tuple[int, str]] = []
    buffer: list[str] = []
    start = 0
    for number, line in lines:
        if not buffer:
            start = number
        if line.rstrip().endswith("\\"):
            buffer.append(line.rstrip()[:-1])
            continue
        buffer.append(line)
        joined.append((start, " ".join(buffer)))
        buffer = []
    if buffer:
        joined.append((start, " ".join(buffer)))
    return joined


def comment_or_blank(line: str) -> bool:
    return not line.strip() or line.lstrip().startswith("#")


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def enclosing_item(lines: list[str], i: int) -> tuple[int, int] | None:
    """The YAML list item that holds line i: (its dash line, the indent of its keys), or None."""
    def item_at(k: int) -> tuple[int, int]:
        after_dash = lines[k].lstrip(" ")[1:]
        return k, indent_of(lines[k]) + 1 + (len(after_dash) - len(after_dash.lstrip(" ")))

    if lines[i].lstrip(" ").startswith("- "):
        return item_at(i)
    threshold = indent_of(lines[i])
    for k in range(i - 1, -1, -1):
        if comment_or_blank(lines[k]):
            continue
        indent = indent_of(lines[k])
        if indent >= threshold:
            continue
        if lines[k].lstrip(" ").startswith("- "):
            return item_at(k)
        threshold = indent
    return None


def step_cwd(lines: list[str], i: int, default: Cwd) -> Cwd:
    """The working directory of the step that holds the `run:` key at line i: its working-directory, else default."""
    item = enclosing_item(lines, i)
    if item is None:
        return default
    k, key_indent = item
    dash_indent = indent_of(lines[k])
    keys = [lines[k].strip()]
    for m in range(k + 1, len(lines)):
        if comment_or_blank(lines[m]):
            continue
        if indent_of(lines[m]) <= dash_indent:
            break
        if indent_of(lines[m]) == key_indent:
            keys.append(lines[m].strip())
    for key in keys:
        match = WORKING_DIRECTORY_RE.match(key)
        if match is None:
            continue
        value = match.group(1).strip().strip("'\"")
        if not value or "${{" in value or UNREADABLE_PATH_RE.search(value) or os.path.isabs(value):
            return (None, f"working-directory {value} cannot be read")
        path = os.path.normpath(value)
        return (path, "") if inside(path) else (None, f"working-directory {value} leaves the repository")
    return default


def workflow_findings(text: str) -> list[tuple[int, list[tuple]]]:
    """(line number, findings) for a workflow file: each step's run script is read in its working directory, every
    other line that mentions npm in the root."""
    lines = text.splitlines()
    default: Cwd = ROOT_CWD
    for i, line in enumerate(lines):
        if WORKING_DIRECTORY_RE.match(line.strip()) and enclosing_item(lines, i) is None:
            default = (None, "a workflow or job default working-directory is not followed")
    out: list[tuple[int, list[tuple]]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if comment_or_blank(line):
            i += 1
            continue
        match = RUN_KEY_RE.match(line)
        if match is None:
            findings: list[tuple] = []
            read_shell(line, ROOT_CWD, findings)
            out.append((i + 1, findings))
            i += 1
            continue
        cwd = step_cwd(lines, i, default)
        value = match.group(3).strip()
        if value[:1] not in ("|", ">"):
            findings = []
            read_shell(value, cwd, findings)
            out.append((i + 1, findings))
            i += 1
            continue
        key_indent = len(match.group(1)) + len(match.group(2) or "")
        block: list[tuple[int, str]] = []
        j = i + 1
        while j < len(lines) and (not lines[j].strip() or indent_of(lines[j]) > key_indent):
            if not comment_or_blank(lines[j]):
                block.append((j + 1, lines[j]))
            j += 1
        for number, script_line in logical_lines(block):
            findings = []
            cwd = read_shell(script_line, cwd, findings)
            out.append((number, findings))
        i = j
    return out


def script_findings(text: str, cwd: Cwd) -> list[tuple[int, list[tuple]]]:
    """(line number, findings) for a shell script read top to bottom, the working directory carried across lines."""
    numbered = [(n, line) for n, line in enumerate(text.splitlines(), start=1) if not comment_or_blank(line)]
    out: list[tuple[int, list[tuple]]] = []
    for number, line in logical_lines(numbered):
        findings: list[tuple] = []
        cwd = read_shell(line, cwd, findings)
        out.append((number, findings))
    return out


def json_string_findings(text: str) -> list[tuple[int, list[tuple]]]:
    """(line number, findings) for a JSON file: every string literal is read as its own command, from the root."""
    out: list[tuple[int, list[tuple]]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        findings: list[tuple] = []
        for literal in re.findall(r'"(?:[^"\\]|\\.)*"', line):
            try:
                value = json.loads(literal)
            except ValueError:
                findings.append(("unreadable", f"JSON string {literal}"))
                continue
            read_shell(value, ROOT_CWD, findings)
        out.append((number, findings))
    return out


def load_allowlist(root: Path, problems: Problems) -> list[dict]:
    path = root / ALLOWLIST
    if not path.is_file():
        return []
    data = load_json(root, path, problems)
    if data is None:
        return []
    entries = data.get("entries")
    if not isinstance(entries, list):
        problems.add(f"{ALLOWLIST}: no entries list")
        return []
    good: list[dict] = []
    for n, entry in enumerate(entries, start=1):
        fields_ok = (
            isinstance(entry, dict)
            and all(isinstance(entry.get(k), str) and entry[k].strip() for k in ("surface", "command", "reason"))
            and isinstance(entry.get("directories"), list)
            and bool(entry["directories"])
            and all(isinstance(d, str) and d.strip() for d in entry["directories"])
        )
        if not fields_ok:
            problems.add(f"{ALLOWLIST}: entry {n} needs surface, command, directories and reason")
            continue
        bad = [
            d for d in entry["directories"]
            if os.path.isabs(d) or UNREADABLE_PATH_RE.search(d) or not inside(os.path.normpath(d))
        ]
        if bad:
            problems.add(f"{ALLOWLIST}: entry {n} directories must be literal paths inside the repository ({', '.join(bad)})")
            continue
        good.append({**entry, "used": False})
    return good


def check_target(root: Path, path: str, where: str, note: str, problems: Problems) -> None:
    directory = root / path
    shown = Path(path).as_posix()
    if not (directory / "package.json").is_file():
        problems.add(f"{where}: npm ci runs in {shown}{note}, which has no package.json")
    elif lockfile_in(directory) is None:
        problems.add(f"{where}: npm ci runs in {shown}{note}, which has no lockfile (npm ci fails without one)")


def report(root: Path, surface: str, where: str, findings: list[tuple], allowlist: list[dict], problems: Problems) -> None:
    for finding in findings:
        kind = finding[0]
        if kind == "non_frozen":
            problems.add(f"{where}: non-frozen npm command {json.dumps(finding[1])} (install with npm ci)")
        elif kind == "unreadable":
            problems.add(
                f"{where}: cannot read this line as shell commands ({finding[1]}); the guard fails closed on a line "
                "that mentions npm"
            )
        elif kind == "ci":
            (path, reason), command = finding[1], finding[2]
            if path is not None:
                check_target(root, path, where, "", problems)
                continue
            entry = next((e for e in allowlist if e["surface"] == surface and e["command"] == command), None)
            if entry is None:
                problems.add(
                    f"{where}: npm ci target cannot be read ({reason}); use a literal --prefix or working directory, "
                    f"or vouch for {json.dumps(command)} in {ALLOWLIST}"
                )
                continue
            entry["used"] = True
            for directory in entry["directories"]:
                check_target(root, os.path.normpath(directory), where, f" (vouched in {ALLOWLIST})", problems)


def lockfile_in(directory: Path) -> Path | None:
    """The lockfile npm ci would use in `directory` (npm-shrinkwrap.json first), or None."""
    for name in ("npm-shrinkwrap.json", "package-lock.json"):
        if (directory / name).is_file():
            return directory / name
    return None


def check_surfaces(root: Path, manifests: list[tuple[Path, dict]], problems: Problems) -> bool:
    """Check 6: every install surface installs frozen, and every npm ci target holds a package.json and a lockfile."""
    before = len(problems.items)
    allowlist = load_allowlist(root, problems)
    surfaces: list[tuple[Path, str]] = []
    workflows = root / ".github" / "workflows"
    if workflows.is_dir():
        surfaces += [(p, "workflow") for p in sorted(workflows.iterdir()) if p.suffix in (".yml", ".yaml") and p.is_file()]
    if (root / ".cursor" / "environment.json").is_file():
        surfaces.append((root / ".cursor" / "environment.json", "json"))
    hooks = root / ".claude" / "hooks"
    if hooks.is_dir():
        surfaces += [(p, "script") for p in sorted(hooks.iterdir()) if p.is_file()]
    for path, kind in surfaces:
        surface = rel(root, path)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as err:
            problems.add(f"{surface}: cannot read ({err.strerror})")
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if not comment_or_blank(line):
                for flag in LOCK_SKIP_RE.findall(line):
                    problems.add(f"{surface}:{number}: {json.dumps(flag)} skips the lockfile (install with npm ci)")
        if kind == "workflow":
            found = workflow_findings(text)
        elif kind == "json":
            found = json_string_findings(text)
        else:
            found = script_findings(text, ROOT_CWD)
        for number, findings in found:
            report(root, surface, f"{surface}:{number}", findings, allowlist, problems)
    for path, manifest in manifests:
        scripts = manifest.get("scripts")
        if not isinstance(scripts, dict):
            continue
        package_dir = rel(root, path.parent) if path.parent != root else "."
        for name, command in sorted(scripts.items()):
            if not isinstance(command, str):
                continue
            where = f"{rel(root, path)}: scripts.{name}"
            for flag in LOCK_SKIP_RE.findall(command):
                problems.add(f"{where}: {json.dumps(flag)} skips the lockfile (install with npm ci)")
            # A script runs in its own package's directory.
            findings: list[tuple] = []
            read_shell(command, (package_dir, ""), findings)
            report(root, rel(root, path), where, findings, allowlist, problems)
    for entry in allowlist:
        if not entry["used"]:
            problems.add(
                f"{ALLOWLIST}: stale entry for {entry['surface']} {json.dumps(entry['command'])} (no npm ci with an "
                "unreadable target matches it)"
            )
    return len(problems.items) == before


def npm_version(npm: list[str]) -> str | None:
    try:
        r = subprocess.run([*npm, "--version"], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = r.stdout.strip()
    return out if r.returncode == 0 and re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.]+)?", out) else None


def npm_ci_dry_run(root: Path, npm: list[str], pin: tuple[str, str], locks: list[Path], problems: Problems) -> list[str]:
    """Checks 7 and 8. Returns PASS lines."""
    passes: list[str] = []
    version = npm_version(npm)
    if version is None:
        problems.add(f"cannot run npm --version (with {' '.join(npm)}); the pinned npm must be on the PATH, or pass --npm")
        return passes
    core = tuple(int(x) for x in version.split("-")[0].split("."))
    if not in_range(core, pin[1]):
        problems.add(
            f"npm {version} is outside the pin {pin[1]} (package.json devEngines.packageManager); run the pinned npm, "
            f"e.g. npx -y {pin[0]} ci"
        )
        return passes
    for lock in locks:
        lock_dir, lock_rel = lock.parent, rel(root, lock)
        args = [*npm, "ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", os.path.abspath(lock_dir)]
        try:
            r = subprocess.run(args, cwd=lock_dir, capture_output=True, text=True, timeout=600)
        except (OSError, subprocess.TimeoutExpired) as err:
            problems.add(f"{lock_rel}: npm ci --dry-run did not run under npm {version} ({err})")
            continue
        if r.returncode == 0:
            passes.append(f"PASS: npm ci --dry-run {lock_rel} (npm {version})")
            continue
        output = f"{r.stdout}\n{r.stderr}"
        npm_errors = [
            line.strip()
            for line in output.splitlines()
            if line.startswith(("npm error", "npm ERR!")) and re.search(r"(code |Missing:|Invalid:|EBADDEVENGINES|in sync|ENOTFOUND|ETARGET|E\d{3})", line)
        ]
        detail = "\n".join(f"    {line}" for line in (npm_errors or output.strip().splitlines()[-10:])[:20])
        problems.add(f"{lock_rel}: npm ci --dry-run exit {r.returncode} under npm {version}\n{detail}")
    return passes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default=".", help="repository root (default: the current directory)")
    parser.add_argument("--npm-ci", action="store_true", help="also run the pinned npm's `npm ci --dry-run` per lockfile")
    parser.add_argument("--npm", default="npm", help="the npm command for --npm-ci (default: npm on the PATH)")
    args = parser.parse_args(argv)

    root = Path(os.path.abspath(args.root))
    problems = Problems()
    passes: list[str] = []

    manifests, locks, foreign = walk(root)
    for path in foreign:
        problems.add(f"{rel(root, path)}: foreign lockfile (the pinned package manager is npm)")

    root_manifest = root / "package.json"
    if not root_manifest.is_file():
        problems.add("package.json: missing at the repository root (the frozen install starts there)")

    loaded: list[tuple[Path, dict]] = []
    for path in manifests:
        manifest = load_json(root, path, problems)
        if manifest is not None:
            loaded.append((path, manifest))

    # Check 1: pairs. A directory with both lockfiles fails (review round, Codex P2-1): npm ci uses
    # npm-shrinkwrap.json and ignores package-lock.json, so the shrinkwrap is the one checked below.
    pairs: list[tuple[Path, Path]] = []
    locks_by_dir: dict[Path, list[Path]] = {}
    for lock in locks:
        locks_by_dir.setdefault(lock.parent, []).append(lock)
    lock_by_dir: dict[Path, Path] = {}
    for directory, dir_locks in sorted(locks_by_dir.items()):
        names = {lock.name: lock for lock in dir_locks}
        if len(names) > 1:
            problems.add(
                f"{rel(root, names['npm-shrinkwrap.json'])} and {rel(root, names['package-lock.json'])}: two lockfiles in "
                "one directory; npm ci uses npm-shrinkwrap.json and ignores package-lock.json (keep one)"
            )
        lock_by_dir[directory] = names.get("npm-shrinkwrap.json") or names["package-lock.json"]
    for lock in locks:
        if not (lock.parent / "package.json").is_file():
            problems.add(f"{rel(root, lock)}: no package.json beside it")
    for path, manifest in loaded:
        lock = lock_by_dir.get(path.parent)
        if lock is not None:
            pairs.append((lock, path))
        elif declares_dependencies(manifest):
            problems.add(f"{rel(root, path)}: declares dependencies but has no package-lock.json beside it")
        elif path == root_manifest:
            # Review round, Codex P2-2: npm ci needs a lockfile even when the root declares nothing.
            problems.add("package.json: no lockfile at the repository root (npm ci fails without one)")

    # Checks 2-4.
    consistent = [rel(root, lock) for lock, manifest_path in pairs if check_lock(root, lock, manifest_path, problems)]
    if pairs and len(consistent) == len(pairs):
        passes.append(f"PASS: {len(pairs)} lockfile{'s' if len(pairs) != 1 else ''} match their manifests ({', '.join(sorted(consistent))})")

    # Check 5.
    manifest_by_path = dict(loaded)
    pins: list[tuple[Path, tuple[str, str]]] = []
    pin_ok = True
    for _lock, manifest_path in sorted(pairs, key=lambda p: rel(root, p[1])):
        manifest = manifest_by_path.get(manifest_path)
        if manifest is None:
            continue
        pin = parse_pin(root, manifest_path, manifest, problems)
        if pin is None:
            pin_ok = False
        else:
            pins.append((manifest_path, pin))
    reference = next((pin for path, pin in pins if path == root_manifest), pins[0][1] if pins else None)
    reference_where = "package.json" if any(path == root_manifest for path, _ in pins) else (rel(root, pins[0][0]) if pins else "")
    for path, pin in pins:
        if reference is not None and pin != reference:
            problems.add(
                f"{rel(root, path)}: npm pin {pin[0]} ({pin[1]}) differs from {reference_where}'s {reference[0]} ({reference[1]})"
            )
            pin_ok = False
    if pairs and pin_ok and reference is not None:
        on_fail = ", ".join(sorted({
            manifest_by_path[path]["devEngines"]["packageManager"]["onFail"] for path, _ in pins
        }))
        passes.append(
            f"PASS: npm pinned to {reference[0]} (devEngines {reference[1]}, onFail {on_fail}) in {len(pins)} "
            f"manifest{'s' if len(pins) != 1 else ''}"
        )

    # Check 6.
    if check_surfaces(root, loaded, problems):
        passes.append("PASS: install surfaces install frozen (npm ci)")

    # Checks 7-8.
    if args.npm_ci:
        if reference is None or not pin_ok:
            problems.add("npm ci --dry-run not run: no valid npm pin to run it under")
        else:
            locks_to_run = sorted((lock for lock, _ in pairs), key=lambda lock: rel(root, lock))
            passes += npm_ci_dry_run(root, shlex.split(args.npm), reference, locks_to_run, problems)

    for line in passes:
        print(line)
    if problems.items:
        for item in problems.items:
            print(f"FAIL {item}")
        print(f"=== lockfile guard FAILED ({len(problems.items)} problem{'s' if len(problems.items) != 1 else ''}) ===")
        return 1
    print("=== lockfile guard PASSED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
