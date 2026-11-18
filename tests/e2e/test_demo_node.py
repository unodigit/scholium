"""The demo node: ``admin seed-demo`` fills a database, ``python -m app`` serves it.

This is how the browser journeys (``npm run test:e2e``) get their data, and the
quickest way for a developer to see the product.  Seeding signs every record
client-side and submits it to the node's own API; the node that then starts on
the same files must serve what was seeded, with every blob verifiable.
"""

from __future__ import annotations

import json
import re

import pytest
from nacl.signing import SigningKey

from e2e_harness import Actor, assert_bytes_match_cid, json_of


@pytest.fixture(scope="module")
def demo(nodes):
    node = nodes.make("demo", smtp=False, jobs="thread")
    node.init_key()
    keys = node.root / "demo-keys.json"
    seeded = node.admin("seed-demo", "--keys-file", str(keys))
    assert seeded.returncode == 0, seeded.stdout + seeded.stderr
    node.seed_output = seeded.stdout  # type: ignore[attr-defined]
    node.demo_keys = keys  # type: ignore[attr-defined]
    node.start_api()
    return node


def seeded_states(demo) -> dict[str, str]:
    """``{sch: id: state}`` as ``seed-demo`` reported them (listed, or still in moderation)."""
    return dict(re.findall(r"(sch:[a-z0-9-]+)\s+(listed|moderation)\b", demo.seed_output))


def public_papers(http) -> list[dict]:
    listing = json_of(http.get("/v1/papers"))
    return listing if isinstance(listing, list) else listing["items"]


def test_the_listed_papers_are_public_and_the_queued_one_is_not(demo):
    states = seeded_states(demo)
    assert sorted(states.values()) == ["listed", "listed", "moderation"], demo.seed_output
    listed = {sid for sid, state in states.items() if state == "listed"}
    queued = next(sid for sid, state in states.items() if state == "moderation")
    with demo.client() as http:
        public = {item["shortId"] for item in public_papers(http)}
        assert public == listed, (public, listed)
        for short_id in listed:
            assert json_of(http.get(f"/v1/papers/{short_id}"))["title"]
        # Waiting for a moderator, the third paper is not part of the public catalog.
        assert queued not in public
        assert http.get(f"/v1/papers/{queued}").status_code == 404


def test_every_listed_manuscript_hashes_to_its_cid(demo):
    with demo.client() as http:
        checked = 0
        for item in public_papers(http):
            manifest = json_of(http.get(f"/v1/papers/{item['shortId']}/v/{item.get('n') or 1}/manifest"))
            for file in manifest.get("files", []):
                served = http.get(f"/v1/content/{file['cid']}")
                assert served.status_code == 200, (item["shortId"], file, served.text)
                assert_bytes_match_cid(served.content, file["cid"])
                checked += 1
        assert checked >= 2


def test_pre_listing_bytes_are_hidden_from_the_public_and_open_to_the_moderator(demo):
    """The queued paper's manuscript is served to moderators and authors only."""
    queued = next(sid for sid, state in seeded_states(demo).items() if state == "moderation")
    with demo.client() as http:
        moderator = demo_actor(demo, http, role="moderator")
        queue = json_of(http.get("/v1/moderation/queue", headers=moderator.headers))
        item = next(i for i in queue if i["short_id"] == queued)
        # The listed-paper routes do not serve a paper that is not listed; the signed
        # records, which are public, name its files.
        version = json_of(http.get(f"/v1/records/{item['version_cid']}"))
        manifest = json_of(http.get(f"/v1/records/{version['body']['manifest']}"))
        cid = next(f["cid"] for f in manifest["body"]["files"] if f.get("role") == "manuscript")
        assert item["scan_result"] == "passed"
        assert http.get(f"/v1/content/{cid}").status_code == 404, "pre-listing bytes were public"
        served = http.get(f"/v1/content/{cid}", headers=moderator.headers)
        assert served.status_code == 200
        assert_bytes_match_cid(served.content, cid)


def demo_actor(demo, http, *, role: str):
    """Sign in as a member of the demo cast, with the key ``seed-demo`` wrote for them."""
    keys = json.loads(demo.demo_keys.read_text())["accounts"]
    account = next(a for a in keys.values() if a["role"] == role)
    actor = Actor(demo, http)
    actor.seed = SigningKey(bytes.fromhex(account["seed"]))
    actor.did = account["did"]
    return actor.sign_in()


def test_the_demo_cast_can_sign_in_with_the_keys_the_seed_wrote(demo):
    with demo.client() as http:
        moderator = demo_actor(demo, http, role="moderator")
        assert moderator.tier == 4
        reviewer = demo_actor(demo, http, role="reviewer")
        assert reviewer.tier == 3


def test_seeding_twice_changes_nothing(demo):
    with demo.client() as http:
        before = json_of(http.get("/v1/sync/head"))
    again = demo.admin("seed-demo", "--keys-file", str(demo.demo_keys))
    assert again.returncode == 0, again.stdout + again.stderr
    with demo.client() as http:
        assert json_of(http.get("/v1/sync/head")) == before
