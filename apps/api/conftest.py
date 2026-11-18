"""Root pytest configuration: hermetic, per-worker state for every test path.

Runs before any test module imports ``app`` (settings are read at import time),
so tests under src/, packages/ and tests/ never share a database, content
directory or node key between xdist workers or with a developer's local data.
"""

import os
import tempfile
from pathlib import Path

import pytest

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


@pytest.fixture(autouse=True)
def _restore_subscriber_registries():
    """Give every test the subscribers it started with, and put them back.

    Plugins subscribe to the ledger (and the version.state_changed event) once,
    when they are imported.  Some tests clear or replace subscribers to isolate
    what they observe; without this, whichever test an xdist worker ran earlier
    decides whether a later test in another module still has, say, the
    subscriber that settles flags when a moderation decision lands.

    A plugin first imported during a test subscribes at import time and will
    never subscribe again, so those newly-imported subscribers are kept; only
    what tests registered (or removed) is restored.
    """
    try:
        from app.modules.ledger import service as ledger_service
    except Exception:  # pragma: no cover - a test path that never imports app
        ledger_service = None
    try:
        from app.modules.submissions import events as submission_events
    except Exception:  # pragma: no cover - a test path that never imports app
        submission_events = None

    if ledger_service is not None:
        with ledger_service._subscribers_lock:
            ledger_saved = {kind: list(bucket) for kind, bucket in ledger_service._subscribers.items()}
    if submission_events is not None:
        with submission_events._subscribers_lock:
            state_saved = list(submission_events._subscribers)

    yield

    if ledger_service is not None:
        with ledger_service._subscribers_lock:
            for kind, bucket in ledger_service._subscribers.items():
                for callback in bucket:
                    module = getattr(callback, "__module__", "") or ""
                    is_test_code = ".tests." in module or module.rsplit(".", 1)[-1].startswith("test_")
                    kept = ledger_saved.setdefault(kind, [])
                    if not is_test_code and callback not in kept:
                        kept.append(callback)
            ledger_service._subscribers.clear()
            ledger_service._subscribers.update(
                {kind: list(bucket) for kind, bucket in ledger_saved.items() if bucket}
            )
    if submission_events is not None:
        with submission_events._subscribers_lock:
            for callback in submission_events._subscribers:
                module = getattr(callback, "__module__", "") or ""
                is_test_code = ".tests." in module or module.rsplit(".", 1)[-1].startswith("test_")
                if not is_test_code and callback not in state_saved:
                    state_saved.append(callback)
            submission_events._subscribers[:] = state_saved
