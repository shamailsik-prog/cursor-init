#!/usr/bin/env python3
"""legacy-governance boundary guard (audit F41; G-0 check [23]).

Frozen ops-reporting / filings lattice chains (LEGACY_GOVERNANCE_CHAINS, default off)
must not expand or leak into active product routes. Manifest:
platform/boundaries/legacyGovernanceQuarantine.json
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from check_next_ai_egress import resolve_repo_module  # noqa: E402
from g0_guard_common import js_module_specifiers, read_text, rel_posix  # noqa: E402

MANIFEST = pathlib.Path("platform/boundaries/legacyGovernanceQuarantine.json")
JS_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
FLAG_DEFAULT_RE = re.compile(
    r"LEGACY_GOVERNANCE_CHAINS:\s*\{[\s\S]*?defaultEnabled:\s*(true|false)",
    re.M,
)


def load_manifest(root: pathlib.Path) -> dict:
    path = root / MANIFEST
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("inventoryVersion") != 1:
        raise ValueError(f"{MANIFEST}: unsupported inventoryVersion")
    return data


def line_count(root: pathlib.Path, rel: str) -> int:
    p = root / rel
    if not p.is_file():
        return -1
    return len(p.read_text(encoding="utf-8", errors="replace").splitlines())


def governance_adapter_paths(root: pathlib.Path, manifest: dict) -> list[str]:
    rule = manifest["quarantinePersistenceModuleRule"]
    directory = rule["directory"]
    prefix = rule["basenamePrefix"]
    suffix = rule["basenameSuffix"]
    base = root / directory
    if not base.is_dir():
        return []
    out: list[str] = []
    for p in sorted(base.iterdir()):
        if not p.is_file():
            continue
        name = p.name
        if name.startswith(prefix) and name.endswith(suffix):
            out.append(rel_posix(p.relative_to(root)))
    return out


def is_quarantine_module(rel: str, manifest: dict) -> bool:
    rel = rel.replace("\\", "/")
    for fixed in manifest.get("quarantineModules", []):
        if rel == fixed.replace("\\", "/"):
            return True
    rule = manifest["quarantinePersistenceModuleRule"]
    directory = rule["directory"].rstrip("/") + "/"
    prefix = rule["basenamePrefix"]
    suffix = rule["basenameSuffix"]
    name = pathlib.Path(rel).name
    if rel.startswith(directory) and name.startswith(prefix) and name.endswith(suffix):
        return True
    for entry in manifest.get("frozenMonoliths", []):
        if rel == entry["path"]:
            return True
    return False


def under_quarantine_path(rel: str, manifest: dict) -> bool:
    rel = rel.replace("\\", "/")
    for prefix in manifest.get("quarantinePathPrefixes", []):
        if rel.startswith(prefix.replace("\\", "/")):
            return True
    return False


def check_budgets(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    for group_name, key in (
        ("frozen monolith", "frozenMonoliths"),
        ("spine coupling", "spineCouplingBudgets"),
    ):
        for entry in manifest.get(key, []):
            rel = entry["path"]
            max_lines = int(entry["maxLines"])
            count = line_count(root, rel)
            if count < 0:
                failures.append(f"{rel}: missing ({group_name} budget)")
            elif count > max_lines:
                failures.append(
                    f"{rel}: {count} lines exceeds {group_name} budget {max_lines} "
                    "(shrink frozen code or raise the budget in the F41 manifest with audit evidence)"
                )
    adapters = governance_adapter_paths(root, manifest)
    cap = int(manifest["maxGovernanceAdapterFiles"])
    if len(adapters) > cap:
        failures.append(
            f"platform/persistence: {len(adapters)} workflowOps*Governance.ts adapters "
            f"exceed cap {cap}"
        )
    return failures


def check_flag_default(root: pathlib.Path) -> list[str]:
    path = root / "platform/flags/featureFlags.ts"
    text = path.read_text(encoding="utf-8")
    m = FLAG_DEFAULT_RE.search(text)
    if not m:
        return ["platform/flags/featureFlags.ts: could not read LEGACY_GOVERNANCE_CHAINS.defaultEnabled"]
    if m.group(1) != "false":
        return ["LEGACY_GOVERNANCE_CHAINS must default to off (E-24)"]
    return []


def iter_active_product_files(root: pathlib.Path, manifest: dict) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for rel_dir in manifest["activeProductImportScanRoots"]:
        base = root / rel_dir
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in JS_SUFFIXES:
                continue
            rel = rel_posix(p.relative_to(root))
            if under_quarantine_path(rel, manifest):
                continue
            files.append(p)
    return files


def check_import_barrier(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    for p in iter_active_product_files(root, manifest):
        rel = rel_posix(p.relative_to(root))
        if under_quarantine_path(rel, manifest):
            continue
        text = read_text(p)
        if text is None:
            continue
        for spec in js_module_specifiers(text):
            target = resolve_repo_module(spec, rel)
            if target is None:
                continue
            for candidate in (target, f"{target}.ts", f"{target}.tsx"):
                if is_quarantine_module(candidate, manifest):
                    failures.append(
                        f"{rel}: imports quarantined legacy governance module {spec} "
                        f"(resolved {candidate})"
                    )
                    break
    return failures


def run(root: pathlib.Path) -> list[str]:
    manifest = load_manifest(root)
    failures: list[str] = []
    failures.extend(check_budgets(root, manifest))
    failures.extend(check_flag_default(root))
    failures.extend(check_import_barrier(root, manifest))
    return failures


def main(argv: list[str]) -> int:
    root = pathlib.Path(argv[0] if argv else ".").resolve()
    failures = run(root)
    if failures:
        print("FAIL: legacy governance boundary (audit F41):")
        for f in sorted(set(failures)):
            print(" ", f)
        return 1
    print(
        "PASS: legacy governance quarantine budgets hold; active product does not import "
        "frozen governance adapters; LEGACY_GOVERNANCE_CHAINS defaults off"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
