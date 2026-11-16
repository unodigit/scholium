"""Tests for the tier-1 (Member) promotion (feature 34).

An account is promoted only when *both* conditions hold and its ``accounts``
row is still at tier 0: a linked ORCID ownership credential and a *verified*
email.  Linking ORCID is the step that runs the check, so most tests drive
:func:`app.modules.orcid.issue_orcid_credential` the way the OAuth callback
does, plus HTTP journeys through ``POST /v1/auth/orcid/complete``.

Each test runs against the plugin conftest's per-test SQLite database, so the
credential, profile, verification and account tables are all freshly created.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app import db
from app.modules.identity.models import Account, ensure_account_table
from app.modules.orcid import (
    MEMBER_TIER,
    has_orcid_credential,
    issue_orcid_credential,
    promote_if_eligible,
    promotion_eligible,
    sign_state,
)
from app.modules.orcid.models import Credential
from app.modules.profiles import (
    ProfileData,
    issue_verification_token,
    mark_email_verified,
    save_profile,
)
from app.security import issue_access_token
from app.settings import settings

COMPLETE = "/v1/auth/orcid/complete"
ORCID = "0000-0002-1825-0097"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _add_account(did: str, tier: int = 0) -> None:
    ensure_account_table()
    with db.SessionLocal() as session:
        session.add(Account(did=did, tier=tier, created_at=_utcnow()))
        session.commit()


def _tier(did: str):
    """Return ``did``'s stored tier, or ``None`` when there is no account row."""
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        return None if account is None else int(account.tier)


def _save_email(did: str, email: str = "ada@example.org") -> None:
    save_profile(did, ProfileData(name="Ada", affiliation="Analytical Engine", email=email))


def _verify_email(did: str, email: str = "ada@example.org") -> None:
    mark_email_verified(did, issue_verification_token(did, email))


# --------------------------------------------------------------------------- #
# Linking promotes only when the email is verified too
# --------------------------------------------------------------------------- #


def test_linking_promotes_a_tier_0_account_with_a_verified_email(node_key, subject_did):
    _add_account(subject_did, tier=0)
    _save_email(subject_did)
    _verify_email(subject_did)

    issue_orcid_credential(subject_did, ORCID)

    assert _tier(subject_did) == MEMBER_TIER
    assert has_orcid_credential(subject_did) is True


def test_linking_with_a_pending_email_leaves_the_account_at_tier_0(node_key, subject_did):
    _add_account(subject_did, tier=0)
    _save_email(subject_did)  # stored, but the link was never redeemed

    issue_orcid_credential(subject_did, ORCID)

    assert _tier(subject_did) == 0
    # The credential is linked regardless: promotion is not a precondition.
    assert has_orcid_credential(subject_did) is True


def test_linking_without_any_profile_leaves_the_account_at_tier_0(node_key, subject_did):
    _add_account(subject_did, tier=0)

    issue_orcid_credential(subject_did, ORCID)

    assert _tier(subject_did) == 0


def test_linking_never_lowers_a_higher_tier(node_key, subject_did):
    _add_account(subject_did, tier=3)
    _save_email(subject_did)
    _verify_email(subject_did)

    issue_orcid_credential(subject_did, ORCID)

    assert _tier(subject_did) == 3


def test_linking_does_not_create_an_account_that_never_signed_in(node_key, subject_did):
    _save_email(subject_did)
    _verify_email(subject_did)

    issue_orcid_credential(subject_did, ORCID)

    assert _tier(subject_did) is None
    assert promote_if_eligible(subject_did) is False
    assert _tier(subject_did) is None


# --------------------------------------------------------------------------- #
# The promotion check itself
# --------------------------------------------------------------------------- #


def test_promotion_requires_a_linked_orcid_credential(node_key, subject_did):
    _add_account(subject_did, tier=0)
    _save_email(subject_did)
    _verify_email(subject_did)

    assert promotion_eligible(subject_did) is False
    assert promote_if_eligible(subject_did) is False
    assert _tier(subject_did) == 0


def test_promotion_is_idempotent_and_reports_only_the_first_move(node_key, subject_did):
    _add_account(subject_did, tier=0)
    _save_email(subject_did)
    _verify_email(subject_did)
    issue_orcid_credential(subject_did, ORCID)

    assert promote_if_eligible(subject_did) is False  # already a Member
    assert _tier(subject_did) == MEMBER_TIER


def test_a_revoked_orcid_credential_does_not_count(node_key, subject_did):
    _add_account(subject_did, tier=0)
    _save_email(subject_did)  # not verified yet, so linking does not promote
    issue_orcid_credential(subject_did, ORCID)
    with db.SessionLocal() as session:
        session.query(Credential).filter(Credential.did == subject_did).update(
            {"status": "revoked"},
            synchronize_session=False,
        )
        session.commit()

    _verify_email(subject_did)

    assert has_orcid_credential(subject_did) is False
    assert promotion_eligible(subject_did) is False
    assert promote_if_eligible(subject_did) is False
    assert _tier(subject_did) == 0


def test_promotion_can_run_from_the_other_half_of_the_pair(node_key, subject_did):
    """A caller that verified the email last may ask for the check itself."""
    _add_account(subject_did, tier=0)
    _save_email(subject_did)
    issue_orcid_credential(subject_did, ORCID)  # email still pending: no promotion
    assert _tier(subject_did) == 0

    _verify_email(subject_did)

    assert promote_if_eligible(subject_did) is True
    assert _tier(subject_did) == MEMBER_TIER


@pytest.mark.parametrize("bad_did", ["", "   ", None, 7])
def test_the_check_ignores_non_dids(bad_did):
    assert has_orcid_credential(bad_did) is False
    assert promotion_eligible(bad_did) is False
    assert promote_if_eligible(bad_did) is False


# --------------------------------------------------------------------------- #
# Completing the OAuth flow runs the same check
# --------------------------------------------------------------------------- #


def test_completing_the_link_promotes_a_tier_0_account_with_a_verified_email(
    client, node_key, subject_did, monkeypatch
):
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)
    _add_account(subject_did, tier=0)
    _save_email(subject_did)
    _verify_email(subject_did)

    response = client.post(
        COMPLETE,
        json={"code": f"mock-{ORCID}", "state": sign_state(did=subject_did)},
        headers={"Authorization": f"Bearer {issue_access_token(subject_did, 0)}"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["credentialSubject"]["orcid"] == ORCID
    assert _tier(subject_did) == MEMBER_TIER


def test_completing_the_link_with_a_pending_email_links_without_promoting(
    client, node_key, subject_did, monkeypatch
):
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)
    _add_account(subject_did, tier=0)
    _save_email(subject_did)

    response = client.post(
        COMPLETE,
        json={"code": f"mock-{ORCID}", "state": sign_state(did=subject_did)},
        headers={"Authorization": f"Bearer {issue_access_token(subject_did, 0)}"},
    )

    assert response.status_code == 200, response.text
    assert _tier(subject_did) == 0
