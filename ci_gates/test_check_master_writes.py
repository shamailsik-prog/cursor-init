#!/usr/bin/env python3
"""FA-Q07-GATE-005. Fails while the guard ignores UPDATE/DELETE/TRUNCATE."""
import pathlib
import tempfile
import unittest

import check_master_writes as gate


class PatternCoversEveryMasterWrite(unittest.TestCase):
    def test_update_delete_truncate_and_change_proposals(self):
        samples = [
            "UPDATE master_knowledge SET snapshot = '{}' WHERE firm_id = 'a'",
            "UPDATE public.master_versions SET author_id = 'forged'",
            "DELETE FROM change_proposals WHERE id = 'x'",
            "DELETE FROM master_versions WHERE firm_id = 'a'",
            "TRUNCATE master_knowledge",
            "TRUNCATE TABLE public.master_versions",
            "INSERT INTO change_proposals (id) VALUES ('x')",
            'INSERT INTO master_knowledge (firm_id) VALUES (\'a\')',
            "INSERT INTO public.master_knowledge (firm_id) VALUES ('a')",
            "INSERT INTO public.master_versions (id) VALUES ('x')",
            'INSERT INTO "master_knowledge" (firm_id) VALUES (\'a\')',
            'INSERT INTO public."master_x" (firm_id) VALUES (\'a\')',
            'INSERT INTO "public"."master_knowledge" (firm_id) VALUES (\'a\')',
            "INSERT INTO public.change_proposals (id) VALUES ('x')",
            "insert into PUBLIC.CHANGE_PROPOSALS (id) values ('x')",
            'UPDATE "master_knowledge" SET snapshot = \'{}\'',
            'DELETE FROM public."change_proposals" WHERE id = \'x\'',
            'TRUNCATE "public"."master_versions"',
        ]
        for sample in samples:
            self.assertIsNotNone(gate.PAT.search(sample), sample)

    def test_a_write_outside_p6_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            planted = root / "services" / "learner" / "write.ts"
            planted.parent.mkdir(parents=True)
            planted.write_text("export function sneak() { return `UPDATE master_knowledge SET snapshot = '{}'` }\n", encoding="utf-8")
            self.assertIn("services/learner/write.ts", gate.scan(root))

    def test_schema_and_quotes_outside_p6_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            planted = root / "services" / "learner" / "write.ts"
            planted.parent.mkdir(parents=True)
            planted.write_text(
                'export const q = `INSERT INTO public."master_knowledge" (firm_id) VALUES (\'a\')`\n',
                encoding="utf-8",
            )
            self.assertIn("services/learner/write.ts", gate.scan(root))

    def test_an_unrelated_insert_is_not_a_master_write(self):
        self.assertIsNone(gate.PAT.search("INSERT INTO public.users (id) VALUES ('a')"))
        self.assertIsNone(gate.PAT.search("UPDATE master SET x = 1"))


if __name__ == "__main__":
    unittest.main()
