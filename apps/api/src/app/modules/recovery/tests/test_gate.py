"""The guardians gate: submissions are 403 problem details until guardians are set."""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.errors import ProblemException, install_exception_handlers
from app.modules import recovery
from app.modules.recovery import GUARDIANS_REQUIRED_TYPE, ensure_guardians_set, require_guardians
from app.security import Principal, require_tier

from .conftest import auth, new_did

PROBLEM = "application/problem+json"


@pytest.fixture
def submit_client():
    """A throwaway app with the recovery routes and one gated 'submission' route."""
    app = FastAPI()
    install_exception_handlers(app)
    app.include_router(recovery.router, prefix="/v1")

    @app.post("/v1/submit")
    def submit(principal: Principal = Depends(require_guardians)) -> dict:
        return {"author": principal.did}

    @app.post("/v1/submit-as-author")
    def submit_as_author(
        author: Principal = Depends(require_tier(2)),
        _guardians: Principal = Depends(require_guardians),
    ) -> dict:
        return {"author": author.did}

    with TestClient(app) as c:
        yield c


def test_a_submission_is_403_problem_details_until_guardians_are_set(submit_client, did):
    response = submit_client.post("/v1/submit", headers=auth(did))

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith(PROBLEM)
    body = response.json()
    assert body["type"] == GUARDIANS_REQUIRED_TYPE
    assert body["status"] == 403
    assert body["title"] == "Forbidden"
    assert body["instance"] == "/v1/submit"
    assert "PUT /v1/me/guardians" in body["detail"]


def test_a_submission_goes_through_once_guardians_are_set(submit_client, did, five_guardians):
    assert submit_client.post("/v1/submit", headers=auth(did)).status_code == 403

    saved = submit_client.put("/v1/me/guardians", json={"guardians": five_guardians}, headers=auth(did))
    assert saved.status_code == 200, saved.text

    response = submit_client.post("/v1/submit", headers=auth(did))
    assert response.status_code == 200, response.text
    assert response.json() == {"author": did}


def test_a_rejected_guardian_list_does_not_open_the_gate(submit_client, did):
    rejected = submit_client.put(
        "/v1/me/guardians", json={"guardians": [new_did() for _ in range(4)]}, headers=auth(did)
    )
    assert rejected.status_code == 422

    assert submit_client.post("/v1/submit", headers=auth(did)).status_code == 403


def test_the_gate_is_per_account(submit_client, five_guardians):
    with_guardians, without = new_did(), new_did()
    submit_client.put("/v1/me/guardians", json={"guardians": five_guardians}, headers=auth(with_guardians))

    assert submit_client.post("/v1/submit", headers=auth(with_guardians)).status_code == 200
    assert submit_client.post("/v1/submit", headers=auth(without)).status_code == 403


def test_an_unauthenticated_submission_is_401_not_403(submit_client):
    response = submit_client.post("/v1/submit")

    assert response.status_code == 401
    assert response.headers["content-type"].startswith(PROBLEM)


def test_the_gate_composes_with_the_tier_check(submit_client, did, five_guardians):
    submit_client.put("/v1/me/guardians", json={"guardians": five_guardians}, headers=auth(did))

    too_low = submit_client.post("/v1/submit-as-author", headers=auth(did, tier=1))
    assert too_low.status_code == 403
    assert too_low.json()["type"] != GUARDIANS_REQUIRED_TYPE  # the tier check, not the gate

    assert submit_client.post("/v1/submit-as-author", headers=auth(did, tier=2)).status_code == 200


def test_ensure_guardians_set_raises_403_problem_for_code_that_knows_the_did(did, five_guardians):
    with pytest.raises(ProblemException) as raised:
        ensure_guardians_set(did)
    assert raised.value.status_code == 403
    assert raised.value.type == GUARDIANS_REQUIRED_TYPE

    recovery.set_guardians(did, five_guardians)

    ensure_guardians_set(did)  # no longer raises
