"""Merging PR #48 rounds 2 and 4 into F19 (#49): how promotion classifies the publication path's
failures.

Promotion quarantines a record (promotion_error:<Class>) only for a failure confirmed to be about
the record: SQLSTATE class 22 or 23 (#48 round 4), and the Annex A publication guard's refusals
(003, SKP01-SKP13), which are decisions about the record. SKP08 is the exception: a
publication-state refusal (publication_isolation_refused, ...) is a deployment or configuration
fault, so it is systemic like 42501 before PR 2b: the record stays pending and the circuit breaker
applies. Transient errors (class 08/40/53/57, 55P03) stay transient. Pure unit tests, no database;
the end-to-end cases are test_f20_trust_policy_db.py::test_i_a_publication_guard_refusal_is_never_
treated_as_transient and the test_f19_m4_* tests in test_f19_publication_db.py.
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


def _publication_error_from(sqlstate):
    """The shape publish_batch produces: PublicationError raised ``from None`` while handling the
    database error, which stays on __context__."""
    from scraper.publication.annex_a import PublicationError

    try:
        try:
            raise _db_error(sqlstate, nested=True)
        except Exception:  # noqa: BLE001
            raise PublicationError("publication_state") from None
    except PublicationError as exc:
        return exc


GUARD_CODES = tuple(f"SKP{n:02d}" for n in range(1, 14))
RECORD_GUARD_CODES = tuple(code for code in GUARD_CODES if code != "SKP08")
INTEGRITY_CODES = ("23502", "23503", "23505", "23514")


class PublicationRefusalsAreNotTransientTests(unittest.TestCase):
    def test_guard_and_integrity_refusals_are_not_transient(self):
        from scraper.tasks.promotion import is_transient_db_error

        wrong = {(code, nested) for code in GUARD_CODES + INTEGRITY_CODES for nested in (False, True)
                 if is_transient_db_error(_db_error(code, nested))}
        self.assertEqual(wrong, set())

    def test_a_publication_error_mapped_from_a_guard_error_is_not_transient(self):
        from scraper.tasks.promotion import is_transient_db_error

        for code in GUARD_CODES:
            self.assertFalse(is_transient_db_error(_publication_error_from(code)), code)

    def test_a_transient_error_during_a_publication_is_still_transient(self):
        """A deadlock, serialization failure, lost connection, cancel or lock timeout while
        publish_batch runs leaves the record pending (round-2 L2), as anywhere else."""
        from scraper.tasks.promotion import is_record_specific_db_error, is_transient_db_error

        for code in ("40P01", "40001", "08006", "57014", "55P03"):
            self.assertTrue(is_transient_db_error(_db_error(code, nested=True)), code)
            self.assertFalse(is_record_specific_db_error(_db_error(code, nested=True)), code)

    def test_sqlstate_class_sk_is_not_a_transient_class(self):
        from scraper.tasks import promotion

        self.assertNotIn("SK", promotion._TRANSIENT_SQLSTATE_CLASSES)
        self.assertFalse(any(code.startswith("SK") for code in promotion._TRANSIENT_SQLSTATES))


class PublicationRefusalsAreRecordSpecificTests(unittest.TestCase):
    """#48 round 4 merged: the guard's refusals are quarantined like class 22/23; SKP08 is systemic."""

    def test_every_guard_refusal_but_skp08_is_record_specific(self):
        from scraper.tasks.promotion import is_record_specific_db_error

        wrong = {(code, nested) for code in RECORD_GUARD_CODES for nested in (False, True)
                 if not is_record_specific_db_error(_db_error(code, nested))}
        wrong |= {code for code in RECORD_GUARD_CODES if not is_record_specific_db_error(_publication_error_from(code))}
        self.assertEqual(wrong, set())
        self.assertEqual(len(RECORD_GUARD_CODES), 12)

    def test_skp08_is_systemic(self):
        """publication_isolation_refused and the other publication-state refusals are a deployment or
        configuration fault: neither transient nor record-specific, so pending + circuit breaker."""
        from scraper.tasks.promotion import is_record_specific_db_error, is_transient_db_error

        for exc in (_db_error("SKP08", False), _db_error("SKP08", True), _publication_error_from("SKP08")):
            self.assertFalse(is_record_specific_db_error(exc))
            self.assertFalse(is_transient_db_error(exc))

    def test_no_corpus_writer_is_systemic(self):
        """Before PR 2b the runtime role cannot publish: publish_batch raises PublicationError
        ("not_corpus_writer") with no SQLSTATE (no membership) or from a 42501 (membership without
        SET). Both leave the record pending; neither is quarantined."""
        from scraper.publication.annex_a import PublicationError
        from scraper.tasks.promotion import is_record_specific_db_error, is_transient_db_error

        plain = PublicationError("not_corpus_writer")
        from_42501 = _publication_error_from("42501")
        for exc in (plain, from_42501, _db_error("42501", True)):
            self.assertFalse(is_record_specific_db_error(exc), exc)
            self.assertFalse(is_transient_db_error(exc), exc)

    def test_unknown_sk_codes_are_not_record_specific(self):
        """Only the codes 003 raises are on the allowlist; another SK code is unknown, so systemic."""
        from scraper.tasks.promotion import is_record_specific_db_error

        for code in ("SKP00", "SKP14", "SKP99", "SKX01"):
            self.assertFalse(is_record_specific_db_error(_db_error(code, nested=True)), code)


if __name__ == "__main__":
    unittest.main()
