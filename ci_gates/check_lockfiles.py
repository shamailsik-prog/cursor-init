#!/usr/bin/env python3
"""Audit F39 (spec docs/superpowers/specs/2026-10-18-f39-frozen-install-design.md, ruling 3): the frozen-install guard.

A clean CI runner or contributor must be able to run `npm ci` from the checked-in manifests. This guard fails when a
lockfile drifts from its package.json, when npm is not pinned, when an install surface installs without the lockfile,
and (with --npm-ci) when the pinned npm's own `npm ci` validator rejects a lockfile.

Static checks (Gate G-0 check [18]; offline):
  1. The root has package.json and package-lock.json. Every lockfile has a package.json beside it, and every
     package.json that declares dependencies or overrides has a lockfile beside it. yarn/pnpm/bun lockfiles fail: the
     pinned package manager is npm.
  2. Each lockfile is lockfileVersion 3 with a root entry (packages[""]).
  3. The root entry equals the manifest for every field npm copies into it (name, version, the dependency maps,
     engines, os, cpu, workspaces); an empty map or list counts as absent. npm never writes `overrides` into a
     lockfile, so override drift is left to check 8.
  4. Every direct dependency has a node_modules/<name> entry in the lockfile.
  5. Every manifest with a lockfile pins npm: packageManager "npm@X.Y.Z" and devEngines.packageManager
     {name "npm", version "~X.Y.Z" or "X.Y.Z", onFail "error"}, packageManager inside that range, one pin for all.
  6. No install surface (.github/workflows/*.yml|yaml, .cursor/environment.json, .claude/hooks/*, package.json
     scripts) runs a non-frozen npm command (install and its aliases, install-test, update, uninstall, dedupe; a
     global install is allowed) or skips the lockfile (--package-lock=false, --no-package-lock). Full-line comments
     are skipped.
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
# npm options that take a separate value, so the value is not read as the subcommand.
VALUE_OPTIONS = frozenset(
    {
        "--prefix", "-C", "--cache", "--registry", "--userconfig", "--globalconfig", "--loglevel", "-w",
        "--workspace", "--omit", "--include", "--install-strategy", "--location", "--script-shell", "--tag",
        "--otp", "--scope", "--node-options", "--cpu", "--os", "--libc",
    }
)
# An `npm` command word: not part of a path, a file name or another word (npm-root.json, npm:root, npx).
NPM_COMMAND_RE = re.compile(r"(?<![\w./@:$-])npm(?=[ \t])")
# Where one shell command ends: a separator, a quote (the command was inside a string) or a subshell end.
COMMAND_END_RE = re.compile(r"[;&|\n\"'`)]")
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
    if pin.get("onFail") != "error":
        problems.add(f'{where}: devEngines.packageManager.onFail is {json.dumps(pin.get("onFail"))}, expected "error"')
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


def surface_lines(root: Path) -> list[tuple[str, int, str]]:
    """(surface, line number, text) for every install surface line outside a full-line comment."""
    surfaces: list[Path] = []
    workflows = root / ".github" / "workflows"
    if workflows.is_dir():
        surfaces += sorted(p for p in workflows.iterdir() if p.suffix in (".yml", ".yaml") and p.is_file())
    if (root / ".cursor" / "environment.json").is_file():
        surfaces.append(root / ".cursor" / "environment.json")
    hooks = root / ".claude" / "hooks"
    if hooks.is_dir():
        surfaces += sorted(p for p in hooks.iterdir() if p.is_file())
    lines: list[tuple[str, int, str]] = []
    for path in surfaces:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if line.lstrip().startswith("#"):
                continue
            lines.append((rel(root, path), number, line))
    return lines


def non_frozen_commands(text: str) -> list[str]:
    """Every npm command in `text` that installs without the lockfile or rewrites it, as written."""
    found: list[str] = []
    for match in NPM_COMMAND_RE.finditer(text):
        rest = text[match.end():]
        end = COMMAND_END_RE.search(rest)
        segment = rest[: end.start()] if end else rest
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()
        subcommand = None
        skip_value = False
        for token in tokens:
            if skip_value:
                skip_value = False
                continue
            if token.startswith("-"):
                if token in VALUE_OPTIONS:
                    skip_value = True
                continue
            subcommand = token
            break
        if subcommand not in NON_FROZEN:
            continue
        is_global = any(t in ("-g", "--global", "--location=global") for t in tokens) or any(
            a == "--location" and b == "global" for a, b in zip(tokens, tokens[1:])
        )
        if not is_global:
            found.append(f"npm {segment.strip()}")
    return found


def check_surfaces(root: Path, manifests: list[tuple[Path, dict]], problems: Problems) -> bool:
    before = len(problems.items)
    for surface, number, line in surface_lines(root):
        for command in non_frozen_commands(line):
            problems.add(f"{surface}:{number}: non-frozen npm command {json.dumps(command)} (install with npm ci)")
        for flag in LOCK_SKIP_RE.findall(line):
            problems.add(f"{surface}:{number}: {json.dumps(flag)} skips the lockfile (install with npm ci)")
    for path, manifest in manifests:
        scripts = manifest.get("scripts")
        if not isinstance(scripts, dict):
            continue
        for name, command in sorted(scripts.items()):
            if not isinstance(command, str):
                continue
            for found in non_frozen_commands(command):
                problems.add(f"{rel(root, path)}: scripts.{name}: non-frozen npm command {json.dumps(found)} (install with npm ci)")
            for flag in LOCK_SKIP_RE.findall(command):
                problems.add(f"{rel(root, path)}: scripts.{name}: {json.dumps(flag)} skips the lockfile (install with npm ci)")
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

    # Check 1: pairs.
    pairs: list[tuple[Path, Path]] = []
    lock_by_dir = {lock.parent: lock for lock in locks}
    for lock in locks:
        if not (lock.parent / "package.json").is_file():
            problems.add(f"{rel(root, lock)}: no package.json beside it")
    for path, manifest in loaded:
        lock = lock_by_dir.get(path.parent)
        if lock is not None:
            pairs.append((lock, path))
        elif declares_dependencies(manifest):
            problems.add(f"{rel(root, path)}: declares dependencies but has no package-lock.json beside it")

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
        passes.append(
            f"PASS: npm pinned to {reference[0]} (devEngines {reference[1]}, onFail error) in {len(pins)} "
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
