"""Merge of PR #48 round 2 into F19 (#49): the publication path's refusals are never transient.

Promotion leaves a record pending only for a transient database error (is_transient_db_error:
connection lost, SQLSTATE class 08/40/53/57, or 55P03). The Annex A publication's own refusals
(SQLSTATE class SK, SKP01-SKP13), integrity errors (class 23) and a PublicationError mapped from one
are the record's fault: the record must be quarantined as promotion_error, not retried forever.
Pure unit tests, no database; the end-to-end case is
test_f20_trust_policy_db.py::test_i_a_publication_guard_refusal_is_never_treated_as_transient.
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


class _Driver(Exception):
    def __init__(self, sqlstate=None):
        super().__init__("driver error")
        if sqlstate is not None:
            self.sqlstate = sqlstate


def _db_error(sqlstate, nested):
    """A SQLAlchemy DBAPIError carrying sqlstate on the adapter exception, or (nested) on the driver
    exception the adapter wraps, as the asyncpg adapter does."""
    from sqlalchemy.exc import DBAPIError

    orig = _Driver(None if nested else sqlstate)
    if nested:
        orig.__cause__ = _Driver(sqlstate)
    return DBAPIError("SELECT 1", {}, orig)


GUARD_CODES = tuple(f"SKP{n:02d}" for n in range(1, 14))
INTEGRITY_CODES = ("23502", "23503", "23505", "23514")


class PublicationRefusalsAreNotTransientTests(unittest.TestCase):
    def test_guard_and_integrity_refusals_are_permanent(self):
        from scraper.tasks.promotion import is_transient_db_error

        wrong = {(code, nested) for code in GUARD_CODES + INTEGRITY_CODES for nested in (False, True)
                 if is_transient_db_error(_db_error(code, nested))}
        self.assertEqual(wrong, set())

    def test_a_publication_error_mapped_from_a_guard_error_is_permanent(self):
        """publish_batch maps begin()/finish() refusals to PublicationError ``from None``; the guard
        error stays on __context__ and must still read as permanent."""
        from scraper.publication.annex_a import PublicationError
        from scraper.tasks.promotion import is_transient_db_error

        for code in ("SKP01", "SKP02", "SKP07", "SKP08", "SKP09", "SKP10", "SKP11", "SKP12"):
            try:
                try:
                    raise _db_error(code, nested=True)
                except Exception:  # noqa: BLE001 - the shape publish_batch produces
                    raise PublicationError("publication_state") from None
            except PublicationError as exc:
                self.assertFalse(is_transient_db_error(exc), code)

    def test_a_transient_error_during_a_publication_is_still_transient(self):
        """A deadlock, serialization failure, lost connection, cancel or lock timeout while
        publish_batch runs leaves the record pending (round-2 L2), as anywhere else."""
        from scraper.tasks.promotion import is_transient_db_error

        for code in ("40P01", "40001", "08006", "57014", "55P03"):
            self.assertTrue(is_transient_db_error(_db_error(code, nested=True)), code)

    def test_sqlstate_class_sk_is_not_a_transient_class(self):
        from scraper.tasks import promotion

        self.assertNotIn("SK", promotion._TRANSIENT_SQLSTATE_CLASSES)
        self.assertFalse(any(code.startswith("SK") for code in promotion._TRANSIENT_SQLSTATES))


if __name__ == "__main__":
    unittest.main()
