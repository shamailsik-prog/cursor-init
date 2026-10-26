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
    version = data.get("inventoryVersion")
    if version not in (1, 2):
        raise ValueError(f"{MANIFEST}: unsupported inventoryVersion {version}")
    return data


def line_count(root: pathlib.Path, rel: str) -> int:
    p = root / rel
    if not p.is_file():
        return -1
    return len(p.read_text(encoding="utf-8", errors="replace").splitlines())


def adapter_rule_directories(manifest: dict) -> list[str]:
    rule = manifest["quarantinePersistenceModuleRule"]
    if "directories" in rule:
        return list(rule["directories"])
    return [rule["directory"]]


def governance_adapter_paths(root: pathlib.Path, manifest: dict) -> list[str]:
    rule = manifest["quarantinePersistenceModuleRule"]
    prefix = rule["basenamePrefix"]
    suffix = rule["basenameSuffix"]
    out: list[str] = []
    for directory in adapter_rule_directories(manifest):
        base = root / directory
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            name = p.name
            if name.startswith(prefix) and name.endswith(suffix):
                out.append(rel_posix(p.relative_to(root)))
    return out


def quarantine_source_files(root: pathlib.Path, prefix: str) -> list[tuple[str, int]]:
    """All JS/TS sources under a quarantine folder prefix (recursive)."""
    norm = prefix.replace("\\", "/").rstrip("/") + "/"
    base = root / norm.rstrip("/")
    if not base.is_dir():
        return []
    found: list[tuple[str, int]] = []
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in JS_SUFFIXES:
            continue
        rel = rel_posix(p.relative_to(root))
        if not rel.startswith(norm):
            continue
        found.append((rel, line_count(root, rel)))
    return found


def is_quarantine_module(rel: str, manifest: dict) -> bool:
    rel = rel.replace("\\", "/")
    for fixed in manifest.get("quarantineModules", []):
        if rel == fixed.replace("\\", "/"):
            return True
    rule = manifest["quarantinePersistenceModuleRule"]
    prefix_name = rule["basenamePrefix"]
    suffix_name = rule["basenameSuffix"]
    name = pathlib.Path(rel).name
    if not (name.startswith(prefix_name) and name.endswith(suffix_name)):
        pass
    else:
        for directory in adapter_rule_directories(manifest):
            dir_prefix = directory.rstrip("/") + "/"
            if rel.startswith(dir_prefix):
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


def check_listed_path_budgets(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    require_exist = bool(manifest.get("listedBudgetPathsMustExist", True))
    for group_name, key in (
        ("frozen monolith", "frozenMonoliths"),
        ("spine coupling", "spineCouplingBudgets"),
    ):
        for entry in manifest.get(key, []):
            rel = entry["path"]
            max_lines = int(entry["maxLines"])
            count = line_count(root, rel)
            if count < 0:
                if require_exist:
                    failures.append(
                        f"{rel}: listed {group_name} budget path is missing "
                        "(rename/delete blocked; restore the file or update the F41 manifest with audit evidence)"
                    )
                continue
            if count > max_lines:
                failures.append(
                    f"{rel}: {count} lines exceeds {group_name} budget {max_lines} "
                    "(shrink frozen code or raise the budget in the F41 manifest with audit evidence)"
                )
    return failures


def check_quarantine_folder_budgets(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    for entry in manifest.get("quarantineFolderBudgets", []):
        prefix = entry["prefix"]
        files = quarantine_source_files(root, prefix)
        total = sum(lines for _rel, lines in files if lines >= 0)
        max_total = int(entry["maxTotalLines"])
        if total > max_total:
            failures.append(
                f"{prefix}: {total} total lines in quarantine sources exceeds folder budget {max_total}"
            )
        if "maxSourceFiles" in entry:
            cap = int(entry["maxSourceFiles"])
            if len(files) > cap:
                failures.append(
                    f"{prefix}: {len(files)} source files exceeds folder file cap {cap} "
                    f"(new files under quarantine folders are blocked)"
                )
    return failures


def check_adapter_budgets(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    adapters = governance_adapter_paths(root, manifest)
    cap = int(manifest["maxGovernanceAdapterFiles"])
    if len(adapters) > cap:
        failures.append(
            f"governance adapters: {len(adapters)} workflowOps*Governance.ts files exceed cap {cap}"
        )
    total_lines = 0
    per_file_cap = int(manifest.get("maxGovernanceAdapterLinesPerFile", 0))
    total_cap = int(manifest.get("maxGovernanceAdapterTotalLines", 0))
    for rel in adapters:
        count = line_count(root, rel)
        if count < 0:
            failures.append(f"{rel}: governance adapter path missing")
            continue
        total_lines += count
        if per_file_cap and count > per_file_cap:
            failures.append(
                f"{rel}: {count} lines exceeds per-adapter budget {per_file_cap} (FA-F41-002 E7)"
            )
    if total_cap and total_lines > total_cap:
        failures.append(
            f"governance adapters: {total_lines} total lines exceed adapter total budget {total_cap}"
        )
    return failures


def check_budgets(root: pathlib.Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    failures.extend(check_listed_path_budgets(root, manifest))
    failures.extend(check_quarantine_folder_budgets(root, manifest))
    failures.extend(check_adapter_budgets(root, manifest))
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
