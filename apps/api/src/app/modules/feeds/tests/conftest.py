"""Fixtures for the feeds plugin's tests.

``DATABASE_URL``/``CONTENT_DIR``/``NODE_KEY_PATH`` are already pointed at this
worker's private temporary state by ``apps/api/conftest.py``; this file only
puts ``src`` on ``sys.path`` for direct invocation and builds a client over
the app the module loader assembles (which is what mounts ``/v1/feeds``).
"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[4]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


@pytest.fixture
def client():
    """A ``TestClient`` over a freshly assembled app (all plugins loaded)."""
    with TestClient(create_app()) as c:
        yield c
