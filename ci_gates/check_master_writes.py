#!/usr/bin/env python3
"""master-write-guard — only P6 may write master tables / master_versions."""
import re, pathlib, sys

ALLOWED_PREFIXES = (
    "platform/p6/",
    "ci_gates/",
    "postgres/ddl/",
    "tests/",
)
SKIP_PARTS = {"node_modules", ".git", ".next", "_superseded", "corpus_service", ".eve"}
# A relation token is schema-qualified and/or quoted. The table name is the last identifier,
# with quotes removed and case folded, so public."master_x" and PUBLIC.CHANGE_PROPOSALS match.
_IDENT = r'(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)'
_QUALIFIED = rf'(?:{_IDENT}\s*\.\s*)*{_IDENT}'
_WRITE = re.compile(
    rf"\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?({_QUALIFIED})",
    re.I,
)
_OTHER = re.compile(
    r"applyChange\s*\("
    r"|writeMaster\s*\("
    r"|sealMasterSession\s*\("
    r"|rollbackMaster\s*\("
    r"|sessionForWrite\s*\("
    r"|\.persistVersion\s*\("
    r"|import\s*\{[^}]*\b(?:writeMaster|sealMasterSession|rollbackMaster)\s+as\b"
    r"""|\[['"]writeMaster['"]\]\s*\("""
    r"|@/platform/p6/masterWrite"
    r"|collection\(\s*['\"]master_versions['\"]"
    r"|match\s+/master_versions/",
    re.I,
)


def relation_name(token: str) -> str:
    parts = re.findall(r'"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)', token)
    idents = [quoted or bare for quoted, bare in parts]
    return idents[-1].lower() if idents else ""


def _protected(verb: str, token: str) -> bool:
    name = relation_name(token)
    if name == "templates":
        return verb.lower().startswith("insert")
    return name == "change_proposals" or name.startswith("master_")


def matches(text: str):
    other = _OTHER.search(text)
    if other:
        return other
    for hit in _WRITE.finditer(text):
        if _protected(hit.group(1), hit.group(2)):
            return hit
    return None


class _Pattern:
    def search(self, text: str):
        return matches(text)


PAT = _Pattern()

# firestore.rules is a deny-write policy, not a writer.
SKIP_FILES = {"firestore.rules"}


def scan(root: pathlib.Path | None = None) -> list[str]:
    base = root or pathlib.Path(".")
    failed: list[str] = []
    for p in base.rglob("*"):
        if p.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".sql"}:
            continue
        rel = p.relative_to(base).as_posix()
        if any(part in SKIP_PARTS for part in rel.split("/")):
            continue
        if any(rel.startswith(a) for a in ALLOWED_PREFIXES):
            continue
        if p.name in SKIP_FILES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if PAT.search(text):
            failed.append(rel)
    return failed


def main() -> int:
    failed = scan()
    if failed:
        print("FAIL: master write outside P6:")
        for f in failed:
            print(" ", f)
        return 1
    print("PASS: no master writes outside P6")
    return 0


if __name__ == "__main__":
    sys.exit(main())
