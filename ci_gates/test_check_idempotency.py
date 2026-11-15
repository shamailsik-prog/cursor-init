#!/usr/bin/env python3
"""FA-Q14A-GUARD-007. The idempotency gate must be behavioural, and the HMAC exemption is POST only."""
from __future__ import annotations

import unittest
from pathlib import Path

import check_idempotency as gate

ROOT = Path(__file__).resolve().parents[1]
WEBHOOK = "app/api/d2/whatsapp/route.ts"


def _webhook(test: unittest.TestCase) -> str:
    path = ROOT / WEBHOOK
    if not path.is_file():
        test.skipTest(f"{WEBHOOK} is not in this tree")
    return path.read_text(encoding="utf-8")


class Guard007(unittest.TestCase):
    def test_import_without_call_fails(self) -> None:
        text = (
            'import { requireIdempotencyKey } from "@/platform/http/idempotency"\n'
            "const kept = requireIdempotencyKey\n"
            "export async function POST(request: Request) {\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        found = gate.violations("app/api/example/route.ts", text, ROOT)
        self.assertTrue(found, msg="an import or a bare binding is not enforcement")

    def test_header_name_in_a_comment_fails(self) -> None:
        text = (
            "export async function POST(request: Request) {\n"
            "  // Idempotency-Key\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        found = gate.violations("app/api/example/route.ts", text, ROOT)
        self.assertTrue(found, msg="mentioning the header is not enforcement")

    def test_webhook_file_exporting_get_fails(self) -> None:
        text = _webhook(self) + (
            "\nexport async function GET(request: Request) {\n"
            "  return handleWhatsAppWebhook(request, { requireIdempotencyKey })\n"
            "}\n"
        )
        found = gate.violations(WEBHOOK, text, ROOT)
        self.assertTrue(any("GET" in item for item in found), msg=found)

    def test_current_webhook_passes(self) -> None:
        self.assertEqual(gate.violations(WEBHOOK, _webhook(self), ROOT), [])

    def test_commented_get_on_the_webhook_does_not_fail(self) -> None:
        text = _webhook(self) + "\n// export async function GET(request: Request) {}\n"
        self.assertEqual(gate.violations(WEBHOOK, text, ROOT), [])

    def test_passing_the_helper_into_a_callee_that_never_calls_it_fails(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            route = base / "app" / "api" / "d2" / "whatsapp" / "route.ts"
            callee = base / "services" / "d2-1" / "webhook.ts"
            route.parent.mkdir(parents=True)
            callee.parent.mkdir(parents=True)
            route.write_text(
                'import { requireIdempotencyKey } from "@/platform/http/idempotency"\n'
                'import { handleWhatsAppWebhook } from "@/services/d2-1/webhook"\n'
                "export async function POST(request: Request) {\n"
                "  return handleWhatsAppWebhook(request, { requireIdempotencyKey })\n"
                "}\n",
                encoding="utf-8",
            )
            callee.write_text(
                "type Deps = { requireIdempotencyKey?: (request: Request) => string }\n"
                "export async function handleWhatsAppWebhook(_request: Request, _deps: Deps) {\n"
                '  return new Response("ok")\n'
                "}\n",
                encoding="utf-8",
            )
            found = gate.violations(WEBHOOK, route.read_text(encoding="utf-8"), base)
            self.assertTrue(found, msg="passing the helper into a function that does not call it is not enforcement")

    def test_a_direct_call_passes(self) -> None:
        text = (
            'import { requireIdempotencyKey } from "@/platform/http/idempotency"\n'
            "export async function POST(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        self.assertEqual(gate.violations("app/api/example/route.ts", text, ROOT), [])

    def test_shipped_tree_passes(self) -> None:
        self.assertEqual(gate.scan(ROOT), [])

    def test_call_inside_an_uncalled_function_fails(self) -> None:
        text = (
            "function unused(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            "}\n"
            "export async function POST(request: Request) {\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        found = gate.violations("app/api/example/route.ts", text, ROOT)
        self.assertTrue(found, msg="a call in a function the handler never calls is not enforcement")

    def test_export_alias_without_a_call_fails(self) -> None:
        text = (
            "function unused(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            "}\n"
            "function handler(request: Request) {\n"
            '  return new Response("ok")\n'
            "}\n"
            "export { handler as POST }\n"
        )
        found = gate.violations("app/api/example/route.ts", text, ROOT)
        self.assertTrue(any("POST" in item for item in found), msg=found)

    def test_export_alias_that_calls_the_helper_passes(self) -> None:
        text = (
            "function handler(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            '  return new Response("ok")\n'
            "}\n"
            "export { handler as POST }\n"
        )
        self.assertEqual(gate.violations("app/api/example/route.ts", text, ROOT), [])

    def test_export_let_without_a_call_fails(self) -> None:
        text = (
            "function unused(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            "}\n"
            "export let POST = async function (request: Request) {\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        found = gate.violations("app/api/example/route.ts", text, ROOT)
        self.assertTrue(any("POST" in item for item in found), msg=found)

    def test_export_let_that_calls_the_helper_passes(self) -> None:
        text = (
            "export let POST = async function (request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        self.assertEqual(gate.violations("app/api/example/route.ts", text, ROOT), [])

    def test_handler_passed_to_a_callee_that_calls_the_helper_passes(self) -> None:
        text = (
            "export async function POST(request: Request) {\n"
            "  return withSession(request, handlePost)\n"
            "}\n"
            "async function handlePost(request: Request) {\n"
            "  requireIdempotencyKey(request)\n"
            '  return new Response("ok")\n'
            "}\n"
        )
        self.assertEqual(gate.violations("app/api/example/route.ts", text, ROOT), [])

    def test_reexport_alias_without_a_call_fails(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            route = base / "app" / "api" / "example" / "route.ts"
            handler = base / "app" / "api" / "example" / "handler.ts"
            route.parent.mkdir(parents=True)
            route.write_text('export { handler as POST } from "./handler"\n', encoding="utf-8")
            handler.write_text(
                "function unused(request: Request) {\n"
                "  requireIdempotencyKey(request)\n"
                "}\n"
                "export function handler(_request: Request) {\n"
                '  return new Response("ok")\n'
                "}\n",
                encoding="utf-8",
            )
            found = gate.violations("app/api/example/route.ts", route.read_text(encoding="utf-8"), base)
            self.assertTrue(any("POST" in item for item in found), msg=found)

    def test_mts_post_without_a_call_fails(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            route = base / "app" / "api" / "example" / "route.mts"
            route.parent.mkdir(parents=True)
            route.write_text(
                "function unused(request: Request) {\n"
                "  requireIdempotencyKey(request)\n"
                "}\n"
                "export async function POST(request: Request) {\n"
                '  return new Response("ok")\n'
                "}\n",
                encoding="utf-8",
            )
            found = gate.scan(base)
            self.assertTrue(any(item.startswith("app/api/example/route.mts") and "POST" in item for item in found), msg=found)

    def test_webhook_export_alias_get_fails(self) -> None:
        text = _webhook(self) + "\nfunction read(request: Request) {\n  return new Response('ok')\n}\nexport { read as GET }\n"
        found = gate.violations(WEBHOOK, text, ROOT)
        self.assertTrue(any("GET" in item for item in found), msg=found)

    def test_commented_export_alias_is_not_an_export(self) -> None:
        text = _webhook(self) + "\n// export { read as GET }\n"
        self.assertEqual(gate.violations(WEBHOOK, text, ROOT), [])


if __name__ == "__main__":
    unittest.main()
