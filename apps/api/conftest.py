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
