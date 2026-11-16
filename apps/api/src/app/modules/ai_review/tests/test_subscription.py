"""The AI pre-review trigger must survive a cleared subscriber registry.

The version-state-changed subscribers live in one process-wide list.  Other
suites and plugins clear it in their teardown (they call
``clear_state_changed_subscribers``) and rely on an ``ensure_subscribed`` hook
to put back what they cleared.  The plugin therefore cannot treat "I have
subscribed once in this process" as proof that its trigger is still wired: a
flag-only guard leaves every listed version without a pre-review job, which is
exactly the dev/demo symptom of an AI pre-review that never appears.
"""

from __future__ import annotations

from app.modules import submissions
from app.modules.ai_review import background


def test_ensure_subscribed_repairs_a_trigger_the_registry_lost():
    background.ensure_subscribed()
    before = submissions.state_changed_subscriber_count()
    assert before >= 1

    # Stand in for another suite clearing the registry: only this plugin's
    # trigger disappears, every other subscriber stays untouched.
    submissions.unsubscribe_state_changed(background._trigger)
    assert submissions.state_changed_subscriber_count() == before - 1

    background.ensure_subscribed()

    assert submissions.state_changed_subscriber_count() == before


def test_ensure_subscribed_still_registers_exactly_one_trigger():
    background.ensure_subscribed()
    background.ensure_subscribed()
    before = submissions.state_changed_subscriber_count()

    background.ensure_subscribed()

    assert submissions.state_changed_subscriber_count() == before
