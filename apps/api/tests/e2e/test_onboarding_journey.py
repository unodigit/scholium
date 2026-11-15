"""Journey: a new DID becomes a Member, is endorsed in cs.AI and is refused in cs.CL.

The story, told only through ``/v1``:

1. a new DID signs in (challenge, signed nonce, tokens) and starts as a Reader;
2. it saves a profile and follows the emailed link, which proves the address;
3. it links an ORCID iD through the (mock) ORCID login -- the last onboarding
   step, and the one that promotes the account to tier 1 (Member);
4. as a Member it still cannot start a paper: submission rights come from an
   endorsement, not from a tier;
5. a Reviewer endorses it in ``cs.AI`` with a signed ``endorsement`` record,
   which lists the endorsement for the newcomer and makes them an Author;
6. starting a paper in ``cs.CL`` -- a category nobody endorsed them in -- is
   refused with 403 and stores nothing, while ``cs.AI`` is accepted.

The email must be verified *before* the ORCID link: linking is what runs the
tier-1 check, and it needs both halves of the pair.
"""

from __future__ import annotations

from scholium_record_core import did_key_from_signing_key

from .helpers import Actor, assert_problem, verification_link_for

ORCID_ID = "0000-0002-1825-0097"
PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

INSUFFICIENT_TIER = "urn:scholium:problem:insufficient-tier"
CATEGORY_NOT_ENDORSED = "urn:scholium:problem:category-not-endorsed"


def genesis_body(*categories: str) -> dict:
    """A ``paper.genesis`` body filing a paper under ``categories``."""
    return {
        "title": f"On the categories {' and '.join(categories)}",
        "categories": list(categories),
        "licence": "CC-BY-4.0",
    }


def profile_tier(client, did: str) -> int:
    """The tier the public profile of ``did`` shows."""
    response = client.get(f"/v1/profiles/{did}")
    assert response.status_code == 200, response.text
    return response.json()["tier"]


def test_new_member_is_endorsed_in_cs_ai_and_refused_in_cs_cl(client, node, reviewer):
    newcomer = Actor(client)

    # 1. A new DID signs in and starts as a Reader.
    newcomer.sign_in()
    assert newcomer.tier == 0
    assert profile_tier(client, newcomer.did) == 0

    # 2. Saving a profile emails a link; following it proves the address.
    saved = client.put(f"/v1/profiles/{newcomer.did}", json=PROFILE, headers=newcomer.headers)
    assert saved.status_code == 200, saved.text

    link = verification_link_for(newcomer.did)  # a mail client sends no access token
    verified = client.post(link)
    assert verified.status_code == 200, verified.text
    assert verified.json() == {"did": newcomer.did, "email_verified": True}
    assert profile_tier(client, newcomer.did) == 0, "a verified email alone is not enough for tier 1"

    # 3. Linking an ORCID iD completes onboarding.  ORCID sends the browser back
    #    with a code (in mock mode ``mock-<orcid>``) and the state the node signed.
    start = client.get("/v1/auth/orcid/start", headers=newcomer.headers)
    assert start.status_code == 200, start.text
    callback = client.get(
        "/v1/auth/orcid/callback",
        params={"code": f"mock-{ORCID_ID}", "state": start.json()["state"]},
    )
    assert callback.status_code == 200, callback.text
    credential = callback.json()
    assert "OrcidOwnershipCredential" in credential["type"]
    assert credential["issuer"] == did_key_from_signing_key(node)
    assert credential["credentialSubject"] == {"id": newcomer.did, "orcid": ORCID_ID}

    # 4. The newcomer is now a Member: the profile shows the linked iD and the
    #    tier, and the next token issued carries it.
    profile = client.get(f"/v1/profiles/{newcomer.did}").json()
    assert profile["orcid"] == ORCID_ID
    assert profile["tier"] == 1
    newcomer.refresh()
    assert newcomer.tier == 1

    # A Member may not start a paper yet, whatever the category.
    too_early = newcomer.submit(newcomer.record("paper.genesis", genesis_body("cs.AI")))
    problem = assert_problem(too_early, 403)
    assert problem["type"] == INSUFFICIENT_TIER
    assert (problem["author_tier"], problem["required_tier"]) == (1, 2)

    # 5. A Reviewer endorses the newcomer in cs.AI with a signed record.
    endorsement = reviewer.record(
        "endorsement", {"endorsee": newcomer.did, "category": "cs.AI", "statement": "Known to the committee."}
    )
    accepted = reviewer.submit(endorsement)
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["id"] == endorsement["id"]
    assert accepted.json()["state"] == "accepted"

    mine = client.get("/v1/me/endorsements", headers=newcomer.headers)
    assert mine.status_code == 200, mine.text
    assert [(e["category"], e["endorser_did"], e["record_cid"]) for e in mine.json()] == [
        ("cs.AI", reviewer.did, endorsement["id"])
    ]
    assert profile_tier(client, newcomer.did) == 2, "an endorsement makes its endorsee an Author"
    newcomer.refresh()
    assert newcomer.tier == 2

    # 6. Author tier is not enough: a paper in cs.CL is refused, naming the
    #    category, and the refused record never reaches the ledger.
    cs_cl = newcomer.record("paper.genesis", genesis_body("cs.CL"))
    refused = newcomer.submit(cs_cl)
    problem = assert_problem(refused, 403)
    assert problem["type"] == CATEGORY_NOT_ENDORSED
    assert problem["unendorsed_categories"] == ["cs.CL"]
    assert "cs.CL" in problem["detail"]
    assert client.get(f"/v1/records/{cs_cl['id']}").status_code == 404

    # The refusal is about the category, not the person: cs.AI is accepted.
    cs_ai = newcomer.record("paper.genesis", genesis_body("cs.AI"))
    started = newcomer.submit(cs_ai)
    assert started.status_code == 201, started.text
    assert started.json()["id"] == cs_ai["id"]
    assert started.json()["shortId"].startswith("sch:")
    assert client.get(f"/v1/records/{cs_ai['id']}").status_code == 200
