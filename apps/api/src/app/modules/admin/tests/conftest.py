"""Fixtures for the admin plugin's tests.

Mirrors the identity plugin's conftest: a per-xdist-worker SQLite database, and
tests that look rows up by their own (random, unique) did rather than asserting
on whole-table counts, so they tolerate workers sharing a database file.
"""

import os
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[4]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
if "PYTEST_XDIST_WORKER" in os.environ:
    os.environ["DATABASE_URL"] = f"sqlite:///./test_{worker}.db"
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///./test_{worker}.db")

import pytest  # noqa: E402
from nacl.signing import SigningKey  # noqa: E402
from scholium_record_core import did_key_from_signing_key  # noqa: E402


@pytest.fixture
def did() -> str:
    """A fresh, valid Ed25519 did:key."""
    return did_key_from_signing_key(SigningKey.generate())
