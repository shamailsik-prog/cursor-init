#!/usr/bin/env python3
"""Tests for ci_gates/check_permission_actions.py (audit FA-F43-R1-P01, G-0 [23]).

Run: python3 ci_gates/test_check_permission_actions.py -v

The shipped tree must pass. A small planted tree (the three P5 entry modules, a table and a caller file per case) must
fail for an action the table does not know, an action from an untyped variable, a template string and every other
failure kind, and must pass for a known literal, a typed parameter, an aliased or relative import and a typed default.
"""
from __future__ import annotations

import io
import json
import tempfile
import textwrap
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import check_permission_actions as gate

ROOT = Path(__file__).resolve().parents[1]

TABLE = """\
export const D1_ACTIONS = [
  "matter.read",
  "client.read",
] as const
export type D1Action = (typeof D1_ACTIONS)[number]
export const NEXT_ROUTE_ACTIONS = ["research", "draft", "committee_brain", "committee_brain_read"] as const
export type NextRouteAction = (typeof NEXT_ROUTE_ACTIONS)[number]
export type CommitteeBrainAction = "committee_brain" | "committee_brain_read"
// "decoy.action" in a comment is not an action
export const UNRELATED = ["decoy.unlisted"] as const
export const DECIDE_ACTIONS = [...D1_ACTIONS, ...NEXT_ROUTE_ACTIONS] as const
export function decide(caller: unknown, action: string, matter: unknown, isMember: boolean) {
  return { allow: false, reason: action }
}
"""

NEXT_ENTRY = """\
import { decide as decideFromTable } from "@/platform/p5/permissionDecision"
export function checkPermission(store: unknown, userId: string, action: string, matterId?: string) {
  return decideFromTable(null, action, matterId, false)
}
"""

FUNCTIONS_ENTRY = """\
import { decide, type D1Action } from "@/platform/p5/permissionDecision"
export async function checkPermission(caller: unknown, action: string, matterId?: string) {
  return evaluate(caller, action)
}
export async function requirePermission(caller: unknown, action: D1Action, matterId?: string) {
  await checkPermission(caller, action, matterId)
}
async function evaluate(caller: unknown, action: string) {
  return decide(caller, action, undefined, false)
}
"""

NEXT = 'import { checkPermission } from "@/platform/p5/checkPermission"\n'
FUNCS = 'import { checkPermission, requirePermission } from "../p5/permission"\n'
DECIDE = 'import { decide } from "@/platform/p5/permissionDecision"\n'


class ShippedTree(unittest.TestCase):
    def test_shipped_tree_passes(self) -> None:
        findings = gate.scan(ROOT)
        self.assertEqual(findings, [], msg="\n".join(str(f) for f in findings))

    def test_known_is_the_parsed_decide_actions(self) -> None:
        known = gate.known_actions(ROOT)
        for action in ("research", "draft", "list_matters", "normalise_case_number", "committee_brain", "committee_brain_read", "matter.read", "alert.ack", "retention.read"):
            self.assertIn(action, known)
        self.assertEqual(len(known), len(set(known)))

    # The inventory of the full repository (every Next route action, both stacks) is asserted by
    # tests/fa-f43-p01-permission-actions-gate.test.ts: G-0's own end-to-end suite (tests/g0-gate-e2e.test.ts) runs this
    # file inside a minimal tree that holds only part of the call sites.


class Planted(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.write("platform/p5/permissionDecision.ts", TABLE)
        self.write("platform/p5/checkPermission.ts", NEXT_ENTRY)
        self.write("functions/src/p5/permission.ts", FUNCTIONS_ENTRY)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text), encoding="utf-8")

    def kinds(self, rel: str | None = None, text: str | None = None) -> list[str]:
        if rel is not None and text is not None:
            self.write(rel, text)
        return sorted(f.kind for f in gate.scan(self.root))

    def assertFails(self, kind: str, text: str, rel: str = "app/api/x/route.ts") -> None:
        found = self.kinds(rel, text)
        self.assertIn(kind, found, msg=f"expected {kind}, got {found}")

    def assertPasses(self, text: str, rel: str = "app/api/x/route.ts") -> None:
        findings = gate.scan(self.root) if not text else (self.write(rel, text), gate.scan(self.root))[1]
        self.assertEqual(findings, [], msg="\n".join(str(f) for f in findings))

    # --- the base tree --------------------------------------------------------------------------------------------

    def test_base_tree_passes_and_parses_the_table(self) -> None:
        self.assertEqual(gate.scan(self.root), [])
        self.assertEqual(gate.known_actions(self.root), ["matter.read", "client.read", "research", "draft", "committee_brain", "committee_brain_read"])

    def test_a_table_without_decide_actions_fails(self) -> None:
        self.write("platform/p5/permissionDecision.ts", TABLE.replace("export const DECIDE_ACTIONS", "export const OTHER"))
        self.assertIn("no_table", self.kinds())

    def test_a_listed_forward_that_no_longer_exists_is_stale(self) -> None:
        self.write("platform/p5/checkPermission.ts", "export function checkPermission() { return null }\n")
        self.assertIn("stale_listing", self.kinds())

    # --- must fail: the three the brief names ----------------------------------------------------------------------

    def test_an_unlisted_literal_fails(self) -> None:
        self.assertFails("unknown_action", NEXT + 'checkPermission(store, userId, "reseach", matterId)\n')

    def test_an_action_from_an_untyped_variable_fails(self) -> None:
        self.assertFails("computed_action", NEXT + 'const a = "research"\ncheckPermission(store, userId, a)\n')

    def test_a_template_string_fails(self) -> None:
        self.assertFails("template_action", NEXT + "const verb = 'search'\ncheckPermission(store, userId, `re${verb}`)\n")

    def test_a_template_without_a_substitution_fails_too(self) -> None:
        self.assertFails("template_action", NEXT + "checkPermission(store, userId, `research`)\n")

    # --- must fail: every other kind -------------------------------------------------------------------------------

    def test_a_typed_union_with_an_unknown_member_fails(self) -> None:
        self.assertFails("unknown_action", NEXT + 'export function f(action: "research" | "bogus") {\n  return checkPermission(store, u, action)\n}\n')

    def test_an_untyped_default_parameter_fails(self) -> None:
        self.assertFails("computed_action", NEXT + 'export function f(action = "research") {\n  return checkPermission(store, u, action)\n}\n')

    def test_a_string_typed_parameter_fails(self) -> None:
        self.assertFails("computed_action", NEXT + "export function f(action: string) {\n  return checkPermission(store, u, action)\n}\n")

    def test_a_member_expression_a_call_a_conditional_and_a_concatenation_fail(self) -> None:
        for expr in ("ACTIONS.research", "actionOf(body)", 'flag ? "research" : "draft"', '"re" + "search"', "...args"):
            with self.subTest(expr=expr):
                self.assertFails("computed_action", NEXT + f"checkPermission(store, u, {expr})\n")

    def test_a_missing_action_argument_fails(self) -> None:
        self.assertFails("missing_action", NEXT + "checkPermission(store, userId)\n")

    def test_an_aliased_import_is_tracked(self) -> None:
        self.assertFails("unknown_action", 'import { checkPermission as cp } from "@/platform/p5/checkPermission"\ncp(store, u, "bogus")\n')

    def test_a_relative_import_of_the_functions_entry_is_tracked(self) -> None:
        self.assertFails("unknown_action", 'import { requirePermission } from "./permission"\nawait requirePermission(caller, "bogus")\n', rel="functions/src/p5/common.ts")

    def test_decide_reads_its_second_argument(self) -> None:
        self.assertFails("unknown_action", DECIDE + 'decide(caller, "bogus", matter, true)\n', rel="functions/src/d1/x.ts")

    def test_the_functions_check_reads_its_second_argument(self) -> None:
        self.assertFails("unknown_action", FUNCS + 'await checkPermission(caller, "bogus", matterId)\n', rel="functions/src/d1/x.ts")

    def test_a_namespace_or_default_import_fails(self) -> None:
        for clause in ("* as p5", "p5", "p5, { checkPermission }"):
            with self.subTest(clause=clause):
                self.assertFails("untracked_binding", f'import {clause} from "@/platform/p5/checkPermission"\n')

    def test_a_re_export_or_export_star_fails(self) -> None:
        for line in ('export { checkPermission } from "@/platform/p5/checkPermission"', 'export * from "@/platform/p5/permissionDecision"', 'export * as t from "@/platform/p5/permissionDecision"'):
            with self.subTest(line=line):
                self.assertFails("untracked_binding", line + "\n")

    def test_a_dynamic_import_or_require_fails(self) -> None:
        for line in ('const m = await import("@/platform/p5/permissionDecision")', 'const m = require("../p5/permission")'):
            with self.subTest(line=line):
                self.assertFails("untracked_binding", line + "\n", rel="functions/src/d1/x.ts")

    def test_an_escaped_reference_fails(self) -> None:
        for line in ("const check = checkPermission", "rows.filter(checkPermission)", "export default checkPermission", "const o = { checkPermission }"):
            with self.subTest(line=line):
                self.assertFails("escaped_reference", NEXT + line + "\n")

    # --- must pass -----------------------------------------------------------------------------------------------

    def test_a_known_literal_passes_in_any_argument_shape(self) -> None:
        self.assertPasses(
            NEXT
            + 'checkPermission(store, getUser(a, b).id, "research", row.matterId)\n'
            + "checkPermission(\n  store,\n  user.id,\n  'draft',\n  { scope: \"own_matters\" }[\"scope\"],\n)\n"
            + 'const rows = list.filter((row) => checkPermission(store, actor.id, "research", row.matterId).allow)\n'
        )

    def test_comments_strings_and_regex_literals_are_not_calls(self) -> None:
        self.assertPasses(
            NEXT
            + '// checkPermission(store, u, "bogus")\n'
            + '/* checkPermission(store, u, "bogus") */\n'
            + 'const s = "checkPermission(store, u, \\"bogus\\")"\n'
            + "const re = /checkPermission\\(\"bogus\"/\n"
            + 'const t = `checkPermission(store, u, "bogus") ${1 + 1}`\n'
            + 'checkPermission(store, u, "research")\n'
        )

    def test_typed_parameters_resolve_through_the_table_types(self) -> None:
        self.assertPasses(
            'import type { D1Action, CommitteeBrainAction as Cb } from "@/platform/p5/permissionDecision"\n'
            + FUNCS
            + "export async function gate(caller: unknown, action: D1Action | \"draft\" = \"matter.read\"): Promise<void> {\n"
            + "  await requirePermission(caller, action)\n}\n"
            + 'export async function g(caller: unknown, action: "matter.read" | "client.read", matterId: string) {\n'
            + "  return checkPermission(caller, action, matterId)\n}\n",
            rel="functions/src/d1/x.ts",
        )
        self.assertPasses(
            'import type { CommitteeBrainAction } from "@/platform/p5/permissionDecision"\n'
            + NEXT
            + 'export async function canAccess(store: unknown, actor: { id: string }, matterId: string, action: CommitteeBrainAction = "committee_brain") {\n'
            + "  return checkPermission(store, actor.id, action, matterId)\n}\n",
            rel="platform/p5/committeeScope.ts",
        )

    def test_a_type_only_import_and_typeof_are_not_references(self) -> None:
        self.assertPasses(
            'import { checkPermission, type PermissionDecision } from "@/platform/p5/checkPermission"\n'
            + "type C = typeof checkPermission\n"
            + 'checkPermission(store, u, "research")\n'
        )

    def test_test_trees_and_build_output_are_not_scanned(self) -> None:
        self.write("functions/test/x.test.ts", FUNCS + 'await checkPermission(caller, "bogus")\n')
        self.write("functions/lib/p5/x.js", FUNCS + 'await checkPermission(caller, "bogus")\n')
        self.write("tests/x.test.ts", NEXT + 'checkPermission(store, u, "bogus")\n')
        self.assertEqual(gate.scan(self.root), [])

    def test_an_escape_spelled_entry_name_is_tracked(self) -> None:
        # The engine binds `checkPermission` to checkPermission; js_lexer decodes it (G-0 [21]'s lexer).
        self.assertFails("unknown_action", NEXT + 'check\\u0050ermission(store, u, "bogus")\n')

    def test_an_escape_spelled_action_literal_is_decoded(self) -> None:
        self.assertPasses(NEXT + 'checkPermission(store, u, "rese\\u0061rch")\n')
        self.assertFails("unknown_action", NEXT + 'checkPermission(store, u, "re\\x73earch!")\n')

    def test_a_tsx_file_is_scanned(self) -> None:
        self.assertFails("unknown_action", NEXT + 'export const C = () => { checkPermission(store, u, "bogus"); return <div /> }\n', rel="components/x.tsx")

    def test_print_known_and_inventory(self) -> None:
        self.write("app/api/x/route.ts", NEXT + 'checkPermission(store, u, "research")\n')
        out = io.StringIO()
        with redirect_stdout(out):
            rc = gate.main(["--root", str(self.root), "--print-known"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out.getvalue()), ["matter.read", "client.read", "research", "draft", "committee_brain", "committee_brain_read"])
        out = io.StringIO()
        with redirect_stdout(out):
            gate.main(["--root", str(self.root), "--print-inventory"])
        rows = json.loads(out.getvalue())
        self.assertIn({"file": "app/api/x/route.ts", "line": 2, "callee": "checkPermission", "entry": "platform/p5/checkPermission", "actions": ["research"], "how": "literal"}, rows)

    def test_main_exits_nonzero_on_a_finding(self) -> None:
        self.write("app/api/x/route.ts", NEXT + 'checkPermission(store, u, "bogus")\n')
        with redirect_stdout(io.StringIO()):
            self.assertEqual(gate.main(["--root", str(self.root)]), 1)


if __name__ == "__main__":
    unittest.main()
