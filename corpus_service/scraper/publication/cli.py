"""Publish a curated batch into the Annex A corpus contract (audit F19).

    python -m scraper.publication.cli publish --batch FILE --actor ID

For curated authority (treatments, statute section histories, judgments) in the
``corpus-publication-batch/1`` format (scraper/publication/batch.py). It connects with DATABASE_URL,
like ``python -m scraper.migrate``; that role must be ``corpus_writer`` or a member of it, and must
not be a superuser. The whole batch is one transaction: it commits as one audited publication or
not at all, and re-running the same file is a no-op.

stdout: one JSON object - publication_id, batch_key, already, seq, counts, and per entity
item_key / entity_type / entity_id / decision / reason / review_status. Never text, titles or URLs.

Exit codes: 0 published (or already published); 2 usage error or a structurally invalid batch;
3 batch_key reused with different content; 4 a superuser or a role that is not a corpus_writer
member; 1 anything else (nothing is written).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Optional, Sequence

from scraper.publication.annex_a import PublicationError, PublicationResult, publish_batch
from scraper.publication.batch import BatchError, load_batch

logger = logging.getLogger("scraper.publication.cli")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_KEY_REUSED = 3
EXIT_NOT_WRITER = 4


async def run_publish(batch_path: Path, actor_id: str) -> PublicationResult:
    """Validate the batch file, then publish it in one transaction on the application's engine."""
    batch = load_batch(batch_path)
    from scraper import database

    try:
        async with database.engine.begin() as conn:
            return await publish_batch(conn, batch, actor_id)
    finally:
        await database.engine.dispose()


def _summary(result: PublicationResult) -> dict:
    return {
        "publication_id": str(result.publication_id),
        "batch_key": result.batch_key,
        "already": result.already,
        "seq": result.seq,
        "counts": dict(result.counts),
        "items": [
            {
                "item_key": o.item_key,
                "entity_type": o.entity_type,
                "entity_id": str(o.entity_id) if o.entity_id is not None else None,
                "decision": o.decision,
                "reason": o.reason,
                "review_status": o.review_status,
            }
            for o in result.outcomes
        ],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m scraper.publication.cli",
                                     description="Publish a curated batch into the Annex A corpus contract.")
    commands = parser.add_subparsers(dest="command", required=True)
    publish = commands.add_parser("publish", help="publish one corpus-publication-batch/1 file")
    publish.add_argument("--batch", required=True, type=Path, help="the batch JSON file")
    publish.add_argument("--actor", required=True, help="who publishes (recorded as the audit actor_id)")
    return parser


def _fail(error: BaseException, code: int, detail: Optional[str] = None) -> int:
    # The class (and a value-free code or field path) only: a message can carry row data.
    suffix = f" {detail}" if detail else ""
    print(f"publication.failed error={type(error).__name__}{suffix}", file=sys.stderr)
    return code


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exit_:
        return int(exit_.code) if isinstance(exit_.code, int) else EXIT_USAGE
    actor = args.actor.strip()
    if not actor or len(actor) > 200:
        print("publication.failed error=UsageError detail=--actor must be 1-200 characters", file=sys.stderr)
        return EXIT_USAGE
    try:
        result = asyncio.run(run_publish(args.batch, actor))
    except BatchError as exc:
        return _fail(exc, EXIT_USAGE, f"detail={exc}")
    except OSError as exc:
        return _fail(exc, EXIT_USAGE)
    except PublicationError as exc:
        if exc.code == "batch_key_reused":
            return _fail(exc, EXIT_KEY_REUSED, f"code={exc.code}")
        if exc.code in ("superuser_session", "not_corpus_writer"):
            return _fail(exc, EXIT_NOT_WRITER, f"code={exc.code}")
        return _fail(exc, EXIT_FAILED, f"code={exc.code}")
    except Exception as exc:  # noqa: BLE001 - any other fault: nothing was committed
        return _fail(exc, EXIT_FAILED)
    print(json.dumps(_summary(result), sort_keys=True))
    return EXIT_OK


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
