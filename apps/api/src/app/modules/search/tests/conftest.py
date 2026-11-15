"""Fixtures for the search plugin's tests.

The root ``apps/api/conftest.py`` already gives every xdist worker its own
database, content directory and node key before ``app`` is imported, so nothing
here chooses a database.
"""

from __future__ import annotations

import pytest

from app.modules import search
from app.modules.submissions import clear_state_changed_subscribers


@pytest.fixture(autouse=True)
def only_the_search_subscriptions():
    """Start each test with exactly this plugin's subscriptions registered.

    The subscriber registries are process-global and other plugins' tests clear
    them, so a test cannot assume the import-time subscription survived.  The
    state-changed registry is emptied so no other plugin's subscriber observes
    (or interferes with) a transition made here; the ledger registry is only
    touched for this plugin's own handler.
    """
    search.uninstall()
    clear_state_changed_subscribers()
    search.install()
    yield
    search.uninstall()
    clear_state_changed_subscribers()
    search.install()
