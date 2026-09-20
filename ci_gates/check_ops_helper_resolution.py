#!/usr/bin/env python3
"""Fail CI when /ops helper calls are unresolved.

This is a focused hardening gate for `runApiCall*` helpers used by the
operator audit console and related /ops files.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

CALL_RE = re.compile(r"(?<![\w.])(runApiCall[A-Za-z0-9_]*)\s*\(")
FUNC_DEF_RE = re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
VAR_DEF_RE = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=")
IMPORT_RE = re.compile(r"import\s+([\s\S]*?)\s+from\s+['\"]([^'\"]+)['\"]\s*;?")
EXPORT_FUNC_RE = re.compile(r"\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
EXPORT_VALUE_RE = re.compile(r"\bexport\s+(?:const|let|var|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
EXPORT_LIST_RE = re.compile(r"\bexport\s*\{([^}]+)\}(?:\s*from\s*['\"]([^'\"]+)['\"])?\s*;?")
EXPORT_ALL_RE = re.compile(r"\bexport\s+\*\s+from\s+['\"]([^'\"]+)['\"]\s*;?")
EXPORT_DEFAULT_RE = re.compile(r"\bexport\s+default\b")

SUPPORTED_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")


@dataclass(frozen=True)
class ImportBinding:
    local_name: str
    imported_name: str | None
    module_specifier: str


@dataclass(frozen=True)
class ModuleExports:
    names: set[str]
    has_default: bool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default="app/ops",
        help="Directory containing ops files to scan (default: app/ops).",
    )
    parser.add_argument(
        "--workspace-root",
        default=".",
        help="Workspace root used to resolve @/ imports (default: current directory).",
    )
    parser.add_argument(
        "--file",
        action="append",
        dest="files",
        default=[],
        help="Specific file(s) to check. If omitted, checks all .ts/.tsx in --root.",
    )
    return parser.parse_args()


def collect_calls(text: str) -> set[str]:
    return set(CALL_RE.findall(text))


def collect_local_definitions(text: str) -> set[str]:
    return set(FUNC_DEF_RE.findall(text)) | set(VAR_DEF_RE.findall(text))


def _split_named_imports(named_block: str) -> list[tuple[str, str]]:
    # Returns tuples of (imported_name, local_name).
    out: list[tuple[str, str]] = []
    for entry in named_block.split(","):
        part = entry.strip()
        if not part:
            continue
        if " as " in part:
            imported_name, local_name = [p.strip() for p in part.split(" as ", 1)]
        else:
            imported_name = part
            local_name = part
        out.append((imported_name, local_name))
    return out


def collect_import_bindings(text: str) -> list[ImportBinding]:
    bindings: list[ImportBinding] = []
    for match in IMPORT_RE.finditer(text):
        raw_spec = match.group(1).strip()
        module_specifier = match.group(2).strip()

        # Namespace import: import * as helpers from "./helpers"
        namespace_match = re.match(r"\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$", raw_spec)
        if namespace_match:
            bindings.append(
                ImportBinding(
                    local_name=namespace_match.group(1),
                    imported_name="*",
                    module_specifier=module_specifier,
                )
            )
            continue

        default_part = ""
        named_part = ""
        if "{" in raw_spec and "}" in raw_spec:
            # import defaultName, { a as b } from "..."
            if raw_spec.startswith("{"):
                named_part = raw_spec
            else:
                before, after = raw_spec.split("{", 1)
                default_part = before.rstrip(", ").strip()
                named_part = "{" + after
        else:
            default_part = raw_spec.strip()

        if default_part:
            bindings.append(
                ImportBinding(
                    local_name=default_part,
                    imported_name=None,
                    module_specifier=module_specifier,
                )
            )

        if named_part:
            named_block = named_part.strip().lstrip("{").rstrip("}")
            for imported_name, local_name in _split_named_imports(named_block):
                bindings.append(
                    ImportBinding(
                        local_name=local_name,
                        imported_name=imported_name,
                        module_specifier=module_specifier,
                    )
                )

    return bindings


def resolve_module_path(specifier: str, from_file: Path, workspace_root: Path) -> Path | None:
    if specifier.startswith("./") or specifier.startswith("../"):
        base = (from_file.parent / specifier).resolve()
    elif specifier.startswith("@/"):
        base = (workspace_root / specifier[2:]).resolve()
    else:
        return None

    candidates: list[Path] = []
    if base.suffix:
        candidates.append(base)
    else:
        candidates.append(base)
        for ext in SUPPORTED_EXTENSIONS:
            candidates.append(Path(str(base) + ext))
        for ext in SUPPORTED_EXTENSIONS:
            candidates.append(base / f"index{ext}")

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _parse_exported_list_items(block: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for piece in block.split(","):
        part = piece.strip()
        if not part:
            continue
        if " as " in part:
            source, exported = [p.strip() for p in part.split(" as ", 1)]
        else:
            source = part
            exported = part
        out.append((source, exported))
    return out


def collect_module_exports(
    module_path: Path,
    workspace_root: Path,
    cache: dict[Path, ModuleExports],
    stack: set[Path],
) -> ModuleExports:
    if module_path in cache:
        return cache[module_path]
    if module_path in stack:
        # Break cyclical export graphs.
        return ModuleExports(names=set(), has_default=False)

    stack.add(module_path)
    text = module_path.read_text(encoding="utf-8", errors="ignore")

    names = set(EXPORT_FUNC_RE.findall(text))
    names.update(EXPORT_VALUE_RE.findall(text))
    has_default = bool(EXPORT_DEFAULT_RE.search(text))

    for match in EXPORT_LIST_RE.finditer(text):
        block = match.group(1)
        source = match.group(2)
        items = _parse_exported_list_items(block)
        if not source:
            names.update(exported for _, exported in items)
            continue
        resolved = resolve_module_path(source, module_path, workspace_root)
        if not resolved:
            continue
        source_exports = collect_module_exports(resolved, workspace_root, cache, stack)
        for source_name, exported_name in items:
            if source_name == "default":
                if source_exports.has_default:
                    names.add(exported_name)
            elif source_name in source_exports.names:
                names.add(exported_name)

    for match in EXPORT_ALL_RE.finditer(text):
        source = match.group(1)
        resolved = resolve_module_path(source, module_path, workspace_root)
        if not resolved:
            continue
        source_exports = collect_module_exports(resolved, workspace_root, cache, stack)
        names.update(source_exports.names)

    stack.remove(module_path)
    exports = ModuleExports(names=names, has_default=has_default)
    cache[module_path] = exports
    return exports


def check_file(file_path: Path, workspace_root: Path) -> list[str]:
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    calls = collect_calls(text)
    if not calls:
        return []

    local_defs = collect_local_definitions(text)
    imports = collect_import_bindings(text)
    helper_imports = [binding for binding in imports if binding.local_name.startswith("runApiCall")]
    imported_local_names = {binding.local_name for binding in helper_imports}

    failures: list[str] = []
    for helper_name in sorted(calls):
        if helper_name not in local_defs and helper_name not in imported_local_names:
            failures.append(
                f"{file_path.as_posix()}: helper '{helper_name}' is called but not locally defined/imported"
            )

    export_cache: dict[Path, ModuleExports] = {}
    for binding in helper_imports:
        resolved_module = resolve_module_path(binding.module_specifier, file_path, workspace_root)
        if not resolved_module:
            # Non-local import path. Import existence is left to TS/ESLint.
            continue
        exports = collect_module_exports(resolved_module, workspace_root, export_cache, set())
        if binding.imported_name is None:
            if not exports.has_default:
                failures.append(
                    f"{file_path.as_posix()}: helper import '{binding.local_name}' expects default export "
                    f"from {binding.module_specifier}, but none was found"
                )
            continue
        if binding.imported_name == "*":
            continue
        if binding.imported_name not in exports.names:
            failures.append(
                f"{file_path.as_posix()}: helper import '{binding.local_name}' expects named export "
                f"'{binding.imported_name}' from {binding.module_specifier}, but it was not found"
            )

    return failures


def gather_target_files(root: Path, explicit_files: list[str]) -> list[Path]:
    if explicit_files:
        return [Path(path).resolve() for path in explicit_files]
    files: list[Path] = []
    for ext in (".ts", ".tsx"):
        files.extend(root.rglob(f"*{ext}"))
    return sorted(file.resolve() for file in files)


def main() -> int:
    args = parse_args()
    workspace_root = Path(args.workspace_root).resolve()
    root = Path(args.root).resolve()
    target_files = gather_target_files(root, args.files)

    failures: list[str] = []
    for file_path in target_files:
        if not file_path.exists() or not file_path.is_file():
            failures.append(f"{file_path.as_posix()}: file not found")
            continue
        failures.extend(check_file(file_path, workspace_root))

    if failures:
        print("FAIL: unresolved /ops runApiCall* helper references detected.")
        for item in failures:
            print(f" - {item}")
        return 1

    print("PASS: /ops runApiCall* helper references resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
