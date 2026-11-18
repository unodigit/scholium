"""The sandbox as its own service: ``python -m app.sandbox_service``, and the API using it.

The service is the other half of ``SANDBOX_BACKEND=remote``.  It is started
alone first (its authentication and its refusal to run bytes that do not hash
to the CID they were asked for), then in the shape a cloud deployment has: the
API and the sandbox are separate processes that share only an object store and
a bearer token, and a paper with a code bundle makes the API's AI pre-review
send that bundle's CID to the service.
"""

from __future__ import annotations

import re

import httpx
import pytest
from scholium_record_core import compute_file_id

from e2e_harness import code_bundle, free_port, poll, publish_listed_paper

TOKEN = "e2e-sandbox-token-" + "s" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = {"completed", "failed", "timeout", "not_run"}


@pytest.fixture(scope="module")
def service(nodes):
    """``python -m app.sandbox_service`` reading bundles from a node's filesystem store."""
    node = nodes.make("sandbox-fs", smtp=False)
    port = free_port()
    process = node.spawn(
        "sandbox", "-m", "app.sandbox_service",
        SANDBOX_TOKEN=TOKEN, SANDBOX_BACKEND="docker", PORT=str(port),
    )
    process.wait_for_http(f"http://127.0.0.1:{port}/healthz")
    return node, f"http://127.0.0.1:{port}"


def test_the_service_demands_the_shared_token(service):
    _, url = service
    # The health check is open (container probes carry no token) and says nothing about the host.
    health = httpx.get(f"{url}/healthz")
    assert health.status_code == 200, health.text
    body = {"bundle_cid": compute_file_id(b"anything")}
    assert httpx.post(f"{url}/runs", json=body).status_code == 401
    assert httpx.post(f"{url}/runs", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert httpx.get(f"{url}/runs/nope").status_code == 401


def test_the_service_refuses_what_it_cannot_run_safely(service):
    node, url = service
    # A request the service does not understand.
    assert httpx.post(f"{url}/runs", json={"bundle_cid": "not-a-cid"}, headers=AUTH).status_code == 422
    assert httpx.post(f"{url}/runs", json={"bundle_cid": compute_file_id(b"x"), "network": True},
                      headers=AUTH).status_code == 422
    # A well-formed id nothing is stored under.
    unknown = httpx.post(f"{url}/runs", json={"bundle_cid": compute_file_id(b"nobody stored this")},
                         headers=AUTH)
    assert unknown.status_code == 422, unknown.text

    # Bytes stored under a CID they do not hash to: refused before anything runs.
    wanted = compute_file_id(b"the bundle the API asked for")
    node.content_dir.mkdir(parents=True, exist_ok=True)
    (node.content_dir / wanted).write_bytes(b"something else entirely")
    swapped = httpx.post(f"{url}/runs", json={"bundle_cid": wanted}, headers=AUTH)
    assert swapped.status_code == 422, swapped.text
    assert str(node.root) not in swapped.text, "the refusal names a path on the host"

    assert httpx.get(f"{url}/runs/does-not-exist", headers=AUTH).status_code == 404


def test_a_stored_bundle_is_accepted_and_runs_to_a_result(service):
    node, url = service
    bundle = code_bundle()
    cid = compute_file_id(bundle)
    (node.content_dir / cid).write_bytes(bundle)

    accepted = httpx.post(f"{url}/runs", json={"bundle_cid": cid}, headers=AUTH)
    assert accepted.status_code == 202, accepted.text
    run_id = accepted.json()["run_id"]

    def finished():
        reply = httpx.get(f"{url}/runs/{run_id}", headers=AUTH)
        assert reply.status_code == 200, reply.text
        return reply.json() if reply.json()["status"] in TERMINAL else None

    result = poll(finished, timeout=120, what="the run to finish", interval=0.5)
    # Whether the code ran depends on the container engine of the machine running
    # the tests; what never varies is that the answer is a result, not a crash.
    assert result["status"] in TERMINAL
    assert isinstance(result["log_lines"], list) and result["log_lines"]
    if result["status"] == "not_run":
        assert result["reason"]


def test_the_service_will_not_start_without_a_usable_token(nodes):
    node = nodes.make("sandbox-bad", smtp=False)
    missing = node.python("-m", "app.sandbox_service", "--port", str(free_port()), SANDBOX_TOKEN=None, timeout=60)
    assert missing.returncode == 2, missing.stdout + missing.stderr
    short = node.python("-m", "app.sandbox_service", "--port", str(free_port()), SANDBOX_TOKEN="short", timeout=60)
    assert short.returncode == 2, short.stdout + short.stderr
    assert "SANDBOX_TOKEN" in short.stderr


def test_an_api_with_a_remote_sandbox_sends_a_papers_bundle_to_it(nodes):
    """Two machines in miniature: API + service share an object store and a token, nothing else."""
    s3 = nodes.s3()
    port = free_port()
    # Archives are scanned for malware before anyone may read or run them, and a
    # scan with no antivirus configured fails closed: the node needs a clamd.
    clamd = nodes.clamd()
    node = nodes.make(
        "remote", storage="s3", jobs="thread", s3=s3, CLAMD_SOCKET=clamd.address,
        SANDBOX_BACKEND="remote", SANDBOX_URL=f"http://127.0.0.1:{port}", SANDBOX_TOKEN=TOKEN,
    )
    node.init_key()
    sandbox = node.spawn(
        "sandbox", "-m", "app.sandbox_service",
        SANDBOX_BACKEND="docker", PORT=str(port), SANDBOX_URL=None,
    )
    sandbox.wait_for_http(f"http://127.0.0.1:{port}/healthz")
    node.start_api()

    with node.client() as http:
        bundle = code_bundle()
        paper = publish_listed_paper(
            node, http, title="Paper with code",
            extra_files=[("code.tar.gz", bundle, "application/gzip", "code")],
        )
        assert paper.files["code.tar.gz"] == compute_file_id(bundle)

        # The AI pre-review of a listed version runs the bundle: the API sends its
        # CID to the service, which fetches the bytes from the shared store itself.
        def asked_the_service() -> bool:
            return bool(re.search(r'"POST /runs HTTP/1\.1" 202', sandbox.log))

        poll(asked_the_service, timeout=120, what="the service to receive the paper's bundle")
        poll(lambda: re.search(r'"GET /runs/([\w-]+) HTTP/1\.1" 200', sandbox.log),
             timeout=60, what="the API to poll the run")

        review = poll(
            lambda: (lambda r: r.json() if r.status_code == 200 and r.json().get("agents") else None)(
                http.get(f"/v1/papers/{paper.short_id}/ai-reviews")),
            timeout=120, what="the AI pre-review",
        )
        assert review["advisory"] is True
        # The service's answer came back through the API into the review: where the
        # code did not run (no container engine here, or no image), the reproducibility
        # agent says so and quotes the line the *service* wrote for the run.
        reproducibility = next(g for g in review["agents"] if g["agent"] == "reproducibility")
        quoted = [f["evidence"].get("log_line", "") for f in reproducibility["findings"]]
        assert all(line.startswith("[scholium-sandbox]") for line in quoted if line), reproducibility
