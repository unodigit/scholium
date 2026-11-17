"""Root pytest configuration: hermetic, per-worker state for every test path.

Runs before any test module imports ``app`` (settings are read at import time),
so tests under src/, packages/ and tests/ never share a database, content
directory or node key between xdist workers or with a developer's local data.
"""

import os
import tempfile
from pathlib import Path

_worker = os.environ.get("PYTEST_XDIST_WORKER", "gw0")
_state = Path(tempfile.mkdtemp(prefix=f"scholium-test-{_worker}-"))

os.environ["DATABASE_URL"] = f"sqlite:///{_state / 'scholium.db'}"
os.environ["CONTENT_DIR"] = str(_state / "content")
os.environ["NODE_KEY_PATH"] = str(_state / "node.key")
os.environ.setdefault("JOBS_EAGER", "1")
os.environ.setdefault("ORCID_MOCK", "1")
os.environ.setdefault("ARXIV_MOCK", "1")
os.environ.setdefault("AI_PROVIDER", "fake")
# The shared app would otherwise throttle the whole suite; the throttle has its own tests.
os.environ["RATE_LIMIT_ENABLED"] = "0"
os.environ.pop("SCHOLIUM_ENV", None)


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _ledger_subscribers_restored():
    """Give every test the ledger subscribers it started with, and put them back.

    Plugins subscribe to the ledger once, when they are imported (the flags
    plugin's flag sync, for one). Some tests clear or replace subscribers to
    isolate what they observe; without this, whichever test an xdist worker ran
    earlier decides whether a later test in another module still has, say, the
    subscriber that settles flags when a moderation decision lands.
    """
    try:
        from app.modules.ledger import service as ledger_service
    except Exception:  # pragma: no cover - a test path that never imports app
        yield
        return
    with ledger_service._subscribers_lock:
        saved = {kind: list(bucket) for kind, bucket in ledger_service._subscribers.items()}
    yield
    with ledger_service._subscribers_lock:
        # A plugin first imported during the test subscribed at import time and
        # will never subscribe again: keep those. Drop what tests registered.
        for kind, bucket in ledger_service._subscribers.items():
            for callback in bucket:
                module = getattr(callback, "__module__", "") or ""
                is_test_code = ".tests." in module or module.rsplit(".", 1)[-1].startswith("test_")
                kept = saved.setdefault(kind, [])
                if not is_test_code and callback not in kept:
                    kept.append(callback)
        ledger_service._subscribers.clear()
        ledger_service._subscribers.update({kind: list(bucket) for kind, bucket in saved.items() if bucket})
