"""The API entrypoint, started the way the README says: ``python -m app``.

With nothing configured at all -- no database URL, no content directory, no
keys -- the process must come up on SQLite and the filesystem, mount every
module's routes, answer its probes and shut down cleanly.  That is the contract
of the default no-container setup that ``npm test`` and a developer's laptop
rely on.
"""

from __future__ import annotations

import signal
import sys

import httpx
import pytest

from e2e_harness import Process, assert_problem, clean_env, free_port

#: The public API surface the product spec lists, as (method, path template).
#: Every one of them must be mounted by the composition root.
SPEC_ROUTES = [
    ("GET", "/healthz"), ("GET", "/readyz"),
    ("POST", "/v1/auth/challenge"), ("POST", "/v1/auth/verify"), ("POST", "/v1/auth/refresh"),
    ("POST", "/v1/auth/logout"), ("GET", "/v1/auth/orcid/start"), ("POST", "/v1/auth/orcid/complete"),
    ("GET", "/v1/auth/orcid/callback"),
    ("POST", "/v1/uploads"), ("PATCH", "/v1/uploads/{upload_id}"), ("HEAD", "/v1/uploads/{upload_id}"),
    ("GET", "/v1/content/{cid}"),
    ("POST", "/v1/records"), ("GET", "/v1/records/{cid}"), ("GET", "/v1/records/{cid}/proof"),
    ("GET", "/v1/papers"), ("GET", "/v1/papers/{paper_id}"), ("GET", "/v1/papers/{paper_id}/versions"),
    ("GET", "/v1/papers/{paper_id}/v/{n}/text"), ("GET", "/v1/papers/{paper_id}/v/{n}/manifest"),
    ("GET", "/v1/papers/{paper_id}/v/{n}/consents"), ("GET", "/v1/papers/{paper_id}/v/{n}/annotations"),
    ("GET", "/v1/papers/{paper_id}/reviews"), ("GET", "/v1/papers/{paper_id}/ai-reviews"),
    ("GET", "/v1/papers/{paper_id}/threads"), ("POST", "/v1/papers/{paper_id}/threads"),
    ("GET", "/v1/papers/{paper_id}/cite"), ("GET", "/v1/papers/{paper_id}/compare"),
    ("GET", "/v1/papers/{paper_id}/coi-check"), ("POST", "/v1/papers/{paper_id}/review-invitations"),
    ("POST", "/v1/reviews/commit"), ("POST", "/v1/reviews/reveal"),
    ("POST", "/v1/reviews/{cid}/response"), ("POST", "/v1/reviews/{cid}/rating"),
    ("POST", "/v1/ai-reviews/{review_cid}/rebuttal"), ("POST", "/v1/ai-reviews/{review_cid}/assessments"),
    ("POST", "/v1/annotations"), ("POST", "/v1/posts/{post_cid}/helpful"),
    ("GET", "/v1/moderation/queue"), ("POST", "/v1/moderation/decisions"), ("GET", "/v1/moderation/policies"),
    ("POST", "/v1/flags"), ("GET", "/v1/flags/{flag_id}"),
    ("POST", "/v1/appeals"), ("POST", "/v1/appeals/{cid}/votes"),
    ("GET", "/v1/profiles/{did}"), ("PUT", "/v1/profiles/{did}"), ("DELETE", "/v1/profiles/{did}"),
    ("POST", "/v1/profiles/{did}/verify-email"), ("GET", "/v1/profiles/{did}/reviews"),
    ("GET", "/v1/did/{did}"), ("GET", "/v1/me/dashboard"), ("GET", "/v1/me/endorsements"),
    ("GET", "/v1/me/notifications"), ("POST", "/v1/me/notifications/{notification_id}/read"),
    ("PUT", "/v1/me/follows/{category}"), ("PUT", "/v1/me/guardians"), ("POST", "/v1/me/mutes"),
    ("POST", "/v1/me/saved-searches"),
    ("POST", "/v1/recovery/requests"), ("POST", "/v1/recovery/requests/{request_id}/approvals"),
    ("POST", "/v1/recovery/requests/{request_id}/cancel"),
    ("GET", "/v1/feeds/{category}"), ("GET", "/v1/search"), ("GET", "/v1/search/semantic"),
    ("GET", "/v1/network"), ("GET", "/v1/oai"),
    ("GET", "/v1/sync/head"), ("GET", "/v1/sync/range"),
    ("GET", "/v1/export/archive.car"), ("GET", "/v1/export/paper/{paper_id}.car"),
    ("GET", "/v1/export/user/{did}.car"),
    ("POST", "/v1/imports/arxiv"), ("POST", "/v1/credentials/present"),
]


@pytest.fixture(scope="module")
def bare(tmp_path_factory):
    """``python -m app`` in an empty directory with only HOST and PORT set."""
    cwd = tmp_path_factory.mktemp("bare")
    port = free_port()
    process = Process(
        "bare:api",
        [sys.executable, "-m", "app"],
        env=clean_env(HOST="127.0.0.1", PORT=str(port)),
        cwd=cwd,
        log_path=cwd / "api.log",
    )
    base = f"http://127.0.0.1:{port}"
    try:
        process.wait_for_http(f"{base}/healthz")
        yield process, base, cwd
    finally:
        process.stop()


def test_boots_with_no_configuration_and_creates_its_defaults(bare):
    process, base, cwd = bare
    assert process.alive, process.log
    # SQLite at ./scholium.db is the default database; nothing else is needed.
    assert (cwd / "scholium.db").exists(), list(cwd.iterdir())
    assert "Application startup complete" in process.log, process.log


def test_probes(bare):
    _, base, _ = bare
    health = httpx.get(f"{base}/healthz")
    assert health.status_code == 200 and health.json() == {"status": "ok"}

    ready = httpx.get(f"{base}/readyz")
    assert ready.status_code == 200, ready.text
    assert ready.json() == {"status": "ok", "checks": {"database": "ok", "object_store": "ok"}}
    assert ready.headers["cache-control"] == "no-store"


def test_every_module_is_mounted(bare):
    _, base, _ = bare
    schema = httpx.get(f"{base}/openapi.json")
    assert schema.status_code == 200
    mounted = {
        (method.upper(), path)
        for path, operations in schema.json()["paths"].items()
        for method in operations
    }
    missing = sorted(route for route in SPEC_ROUTES if route not in mounted)
    assert not missing, f"routes the spec lists but the app does not serve: {missing}"


def test_public_reads_work_on_an_empty_node(bare):
    _, base, _ = bare
    papers = httpx.get(f"{base}/v1/papers")
    assert papers.status_code == 200, papers.text
    assert httpx.get(f"{base}/v1/moderation/policies").status_code == 200
    assert httpx.get(f"{base}/v1/network").status_code == 200
    assert httpx.get(f"{base}/v1/search", params={"q": "anything"}).status_code == 200
    # The sync head is signed with the node key, which a fresh node does not have
    # until the operator runs `init-node`: that is a 503 problem, not a crash.
    assert_problem(httpx.get(f"{base}/v1/sync/head"), 503)


def test_errors_are_problem_documents(bare):
    _, base, _ = bare
    unknown = assert_problem(httpx.get(f"{base}/v1/no-such-route"), 404)
    assert unknown["status"] == 404

    # A protected route without a token is a 401 problem, never a stack trace.
    assert_problem(httpx.get(f"{base}/v1/me/dashboard"), 401)
    assert_problem(httpx.get(f"{base}/v1/moderation/queue"), 401)
    # A paper that does not exist is a 404 problem.
    assert_problem(httpx.get(f"{base}/v1/papers/sch:aaaa-bbbb-cccc"), 404)
    # A malformed body is a 4xx problem, not a 500.
    bad = httpx.post(f"{base}/v1/auth/challenge", json={"nonsense": True})
    assert 400 <= bad.status_code < 500, bad.text


def test_cors_allows_the_default_web_origin_only(bare):
    _, base, _ = bare
    allowed = httpx.options(
        f"{base}/v1/records",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert allowed.headers["access-control-allow-credentials"] == "true"

    stranger = httpx.options(
        f"{base}/v1/records",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in stranger.headers


def test_sigterm_shuts_down_cleanly(tmp_path):
    port = free_port()
    process = Process(
        "term:api",
        [sys.executable, "-m", "app"],
        env=clean_env(HOST="127.0.0.1", PORT=str(port)),
        cwd=tmp_path,
        log_path=tmp_path / "api.log",
    )
    process.wait_for_http(f"http://127.0.0.1:{port}/healthz")
    # uvicorn finishes its graceful shutdown (lifespan included) and then re-raises
    # the signal, so the status is "killed by SIGTERM" (-15, shell status 143), not 0.
    status = process.stop(signal.SIGTERM, timeout=30)
    assert status in (0, -signal.SIGTERM), (status, process.log)
    assert "Application shutdown complete" in process.log, process.log
    with pytest.raises(httpx.TransportError):
        httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=2)
