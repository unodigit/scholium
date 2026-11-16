"""Journey: a reader's flag becomes a correction, and every version shows it.

The story, told through ``/v1``:

1. an author publishes version 1 and version 2 of a paper and a moderator
   lists both, so the paper is in the public catalog;
2. a reader files a flag against the paper, citing a reason category;
3. a moderator acts on the flag and holds the latest version with a signed
   ``moderation.decision`` citing a policy clause -- the paper is now
   *contested* to every reader;
4. the author appeals the hold, naming the decision and their grounds.  The
   node seats a deterministic three-member panel of tier-3/4 members, never the
   deciding moderator and never an author;
5. two of the three panel members independently back ``overturned``; with a
   majority the node signs an ``appeal.decision`` and appends it to the public
   log;
6. acting on the panel's outcome, a moderator lists the held version again --
   an appeal decision is a public outcome, and the record that changes a
   version's state is still a ``moderation.decision``;
7. the author publishes a ``correction`` notice for the paper;
8. the paper reads *corrected*, and the same correction notice is attached to
   every version -- v1 and v2 -- as the catalog serves them.

The version states and the paper status are read back through the public
catalog, which is what a reader sees.
"""

from __future__ import annotations

import io

from pypdf import PdfWriter
from scholium_record_core import sign_record

from app import jobs
from app.modules.admin.cli import main as admin_cli
from app.modules.appeals import get_panel
from app.modules.submissions import get_version

from .helpers import Actor, verification_link_for

ORCID_ID = "0000-0002-1825-0097"
PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

#: The version state while it waits for a moderator.
MODERATION = "moderation"
#: The version state after a moderator lists it.
LISTED = "listed"
#: The version state a hold sets, and which makes the paper *contested*.
HELD = "held"

#: The paper status the catalog reports while a moderation hold is in force.
CONTESTED = "contested"
#: The paper status the correction notice produces once the hold is lifted.
CORRECTED = "corrected"

FLAG = "/v1/flags"
RECORDS = "/v1/records"
DECISIONS = "/v1/moderation/decisions"
APPEALS = "/v1/appeals"

#: Deliberately dated, so the newest state-setting decision on a version is
#: unambiguous however fast the journey runs.  ``compute_status`` compares a
#: decision's ``created`` (and breaks ties by record id), so decisions made in
#: the same second would order unpredictably.
LISTED_AT = "2026-01-01T00:00:00Z"
HELD_AT = "2026-01-01T00:00:01Z"
RELISTED_AT = "2026-01-01T00:00:02Z"


def blank_pdf() -> bytes:
    """A minimal, valid one-page PDF."""
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def upload_pdf(client, data: bytes, *, headers: dict[str, str] | None = None) -> str:
    """Upload ``data`` as a manuscript over tus and return its content id.

    ``headers`` carries the uploading account's ``Authorization``: an upload
    belongs to the DID that creates it, so the same caller must also append.
    """
    auth = dict(headers or {})
    created = client.post(
        "/v1/uploads",
        headers={**auth, "Tus-Resumable": "1.0.0", "Upload-Length": str(len(data))},
    )
    assert created.status_code == 201, created.text
    upload_id = created.headers["Location"].rsplit("/", 1)[-1]
    patched = client.patch(
        f"/v1/uploads/{upload_id}",
        content=data,
        headers={
            **auth,
            "Tus-Resumable": "1.0.0",
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": "0",
        },
    )
    assert patched.status_code == 204, patched.text
    cid = patched.headers.get("Upload-Cid")
    assert cid, patched.headers
    return cid


def make_author(client, reviewer) -> Actor:
    """A verified, ORCID-linked author endorsed in ``cs.AI`` (tier 2)."""
    author = Actor(client)
    author.sign_in()
    saved = client.put(f"/v1/profiles/{author.did}", json=PROFILE, headers=author.headers)
    assert saved.status_code == 200, saved.text
    client.post(verification_link_for(author.did))
    author.link_orcid(ORCID_ID)
    author.refresh()
    endorsement = reviewer.record(
        "endorsement", {"endorsee": author.did, "category": "cs.AI", "statement": "ok"}
    )
    accepted = reviewer.submit(endorsement)
    assert accepted.status_code == 201, accepted.text
    author.refresh()
    assert author.tier == 2
    return author


def make_reviewer(client) -> Actor:
    """A signed-in tier-3 Reviewer, appointed the way the operator does it."""
    actor = Actor(client)
    actor.sign_in()
    assert admin_cli(["set-tier", actor.did, "reviewer"]) == 0
    actor.refresh()
    assert actor.tier == 3
    return actor


def record_dated(actor: Actor, record_type: str, body: dict, created: str) -> dict:
    """A signed record dated ``created`` instead of now (see ``LISTED_AT``)."""
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": actor.did,
            "created": created,
            "prev": None,
            "body": body,
            "proofs": [],
        },
        actor.seed,
    )


def publish_version(
    client,
    author: Actor,
    moderator: Actor,
    *,
    paper_cid: str,
    n: int,
    prev: str,
    manifest_cid: str,
    short_id: str,
    listed_at: str,
) -> str:
    """Sign, consent to, scan and list version ``n``; return its version cid.

    The author is the paper's only byline entry, so one consent completes the
    round.  The eager scan job then passes the version to moderation, where a
    signed decision lists it.  ``listed_at`` dates that decision, so the hold
    and the relisting that follow it are unambiguously newer.
    """
    version = author.record(
        "paper.version",
        {
            "paper": paper_cid,
            "n": n,
            "title": f"Disputed paper v{n}",
            "abstract": f"Version {n} of a paper with a disputable result.",
            "authors": [
                {"did": author.did, "position": 1, "creditRoles": ["Conceptualization"]}
            ],
            "manifest": manifest_cid,
            "licence": "CC-BY-4.0",
            "changeNote": f"v{n}",
        },
        prev=prev,
    )
    submitted = author.submit(version)
    assert submitted.status_code == 201, submitted.text
    version_cid = version["id"]

    consent = author.record(
        "coauthor.consent",
        {"version": version_cid, "role": "Conceptualization", "decision": "accept"},
    )
    consented = author.submit(consent)
    assert consented.status_code == 201, consented.text

    # Every author has accepted, so the version scans; a clean scan moves it to
    # the moderator's queue.
    jobs.run_pending()
    row = get_version(version_cid)
    assert row is not None
    assert row.state == MODERATION, row.state

    policies = client.get("/v1/moderation/policies")
    assert policies.status_code == 200, policies.text
    clause_id = policies.json()[0]["id"]

    decision = client.post(
        DECISIONS,
        json=record_dated(
            moderator,
            "moderation.decision",
            {
                "target": version_cid,
                "action": "list",
                "clause": clause_id,
                "reason": "In scope and the checks passed.",
            },
            listed_at,
        ),
        headers=moderator.headers,
    )
    assert decision.status_code == 201, decision.text
    assert decision.json()["state"] == LISTED, decision.text
    assert decision.json()["shortId"] == f"{short_id}/v{n}", decision.text

    row = get_version(version_cid)
    assert row is not None and row.state == LISTED, row.state
    return version_cid


def test_dispute_journey(client, node, reviewer):
    # A moderator, appointed the way the node operator does it: the admin CLI.
    moderator = Actor(client)
    moderator.sign_in()
    assert admin_cli(["set-tier", moderator.did, "moderator"]) == 0
    moderator.refresh()
    assert moderator.tier == 4

    # Three tier-3 members stand for the appeal panel.  With only these three
    # eligible (the moderator and the author are excluded) the draw is exactly
    # them, whichever cids it is seeded from.
    panel_pool = [reviewer, make_reviewer(client), make_reviewer(client)]
    by_did = {actor.did: actor for actor in panel_pool}

    author = make_author(client, reviewer)

    # --- version 1 and version 2 are published and listed -------------------
    pdf_bytes = blank_pdf()
    file_cid = upload_pdf(client, pdf_bytes, headers=author.headers)
    manifest = author.record(
        "manifest",
        {
            "files": [
                {
                    "path": "main.pdf",
                    "cid": file_cid,
                    "size": len(pdf_bytes),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    submitted = author.submit(manifest)
    assert submitted.status_code == 201, submitted.text
    manifest_cid = manifest["id"]

    genesis = author.record(
        "paper.genesis",
        {
            "title": "A disputable result",
            "abstract": "A paper whose result a reader doubts.",
            "categories": ["cs.AI"],
            "licence": "CC-BY-4.0",
            "authors": [author.did],
        },
    )
    submitted = author.submit(genesis)
    assert submitted.status_code == 201, submitted.text
    paper_cid = genesis["id"]
    short_id = submitted.json().get("shortId") or submitted.json().get("short_id")
    assert short_id and short_id.startswith("sch:"), submitted.text

    v1 = publish_version(
        client,
        author,
        moderator,
        paper_cid=paper_cid,
        n=1,
        prev=paper_cid,
        manifest_cid=manifest_cid,
        short_id=short_id,
        listed_at=LISTED_AT,
    )
    v2 = publish_version(
        client,
        author,
        moderator,
        paper_cid=paper_cid,
        n=2,
        prev=v1,
        manifest_cid=manifest_cid,
        short_id=short_id,
        listed_at=LISTED_AT,
    )
    listed = client.get(f"/v1/papers/{short_id}/versions")
    assert listed.status_code == 200, listed.text
    assert [version["n"] for version in listed.json()["versions"]] == [1, 2], listed.text

    # --- 2. a reader flags the paper ---------------------------------------
    reader = Actor(client)
    reader.sign_in()
    filed = client.post(
        FLAG,
        json={"target": paper_cid, "reason": "plagiarism"},
        headers=reader.headers,
    )
    assert filed.status_code == 201, filed.text
    flag_id = filed.json()["id"]
    assert filed.json()["status"] == "pending", filed.text
    assert filed.json()["target_cid"] == paper_cid, filed.text
    assert filed.json()["reporter_did"] == reader.did, filed.text

    # The reporter can follow their flag; it has no decision linked yet.
    seen = client.get(f"{FLAG}/{flag_id}", headers=reader.headers)
    assert seen.status_code == 200, seen.text
    assert seen.json()["status"] == "pending", seen.text
    assert seen.json()["decision_cid"] is None, seen.text

    # --- 3. a moderator holds the latest version ---------------------------
    policies = client.get("/v1/moderation/policies")
    assert policies.status_code == 200, policies.text
    clause_id = policies.json()[0]["id"]

    hold = record_dated(
        moderator,
        "moderation.decision",
        {
            "target": v2,
            "action": "hold",
            "clause": clause_id,
            "reason": "Plagiarism concern; held pending review.",
        },
        HELD_AT,
    )
    held = client.post(DECISIONS, json=hold, headers=moderator.headers)
    assert held.status_code == 201, held.text
    assert held.json()["state"] == HELD, held.text
    assert held.json()["shortId"] == f"{short_id}/v2", held.text

    row = get_version(v2)
    assert row is not None and row.state == HELD, row.state
    contested = client.get(f"/v1/papers/{short_id}")
    assert contested.status_code == 200, contested.text
    assert contested.json()["status"] == CONTESTED, contested.text

    # --- 4. the author appeals the hold ------------------------------------
    appeal = author.record(
        "appeal",
        {
            "target": hold["id"],
            "decision": hold["id"],
            "paper": paper_cid,
            "grounds": "The work is original; the flagged passage is a quotation.",
        },
    )
    submitted = client.post(APPEALS, json=appeal, headers=author.headers)
    assert submitted.status_code == 201, submitted.text
    body = submitted.json()
    assert body["id"] == appeal["id"], body
    assert body["target"] == hold["id"], body
    assert body["status"] == "pending", body
    assert body["shortId"] == f"{short_id}/v2", body

    # The panel is exactly the three eligible members, and never the deciding
    # moderator or an author.
    seated = [row.member_did for row in get_panel(appeal["id"])]
    assert len(seated) == 3, seated
    assert set(seated) == set(by_did), seated
    assert moderator.did not in seated and author.did not in seated

    # --- 5. two panel members back the same outcome ------------------------
    first, second = seated[0], seated[1]
    vote = client.post(
        f"{APPEALS}/{appeal['id']}/votes",
        json={"outcome": "overturned", "reasons": "The quotation is attributed."},
        headers=by_did[first].headers,
    )
    assert vote.status_code == 200, vote.text
    assert vote.json()["counted"] is True, vote.text
    assert vote.json()["votes"] == 1, vote.text
    assert vote.json()["decision"] is None, vote.text

    majority = client.post(
        f"{APPEALS}/{appeal['id']}/votes",
        json={"outcome": "overturned", "reasons": "The hold is not supported."},
        headers=by_did[second].headers,
    )
    assert majority.status_code == 200, majority.text
    assert majority.json()["votes"] == 2, majority.text
    assert majority.json()["outcome"] == "overturned", majority.text
    appeal_decision = majority.json()["decision"]
    assert appeal_decision, majority.text

    # The panel's decision is a node-signed record in the public log.
    decided = client.get(f"{RECORDS}/{appeal_decision}")
    assert decided.status_code == 200, decided.text
    record = decided.json()
    assert record["type"] == "appeal.decision", record
    assert record["body"]["target"] == appeal["id"], record
    assert record["body"]["outcome"] == "overturned", record
    assert set(record["body"]["reasons"]) == {
        "The quotation is attributed.",
        "The hold is not supported.",
    }, record
    assert record["author"].startswith("did:key:"), record

    # --- 6. the hold is lifted in response ---------------------------------
    relist = record_dated(
        moderator,
        "moderation.decision",
        {
            "target": v2,
            "action": "list",
            "clause": clause_id,
            "reason": "Appeal overturned; the paper is restored.",
        },
        RELISTED_AT,
    )
    relisted = client.post(DECISIONS, json=relist, headers=moderator.headers)
    assert relisted.status_code == 201, relisted.text
    assert relisted.json()["state"] == LISTED, relisted.text
    row = get_version(v2)
    assert row is not None and row.state == LISTED, row.state

    # --- 7. the author publishes a correction ------------------------------
    correction = author.record(
        "correction",
        {
            "target": paper_cid,
            "paper": paper_cid,
            "reason": "The flagged passage is a quotation and is now attributed.",
        },
    )
    submitted = author.submit(correction)
    assert submitted.status_code == 201, submitted.text
    correction_cid = correction["id"]
    assert correction_cid == submitted.json()["id"], submitted.text

    # --- 8. the Corrected notice shows on every version --------------------
    latest = client.get(f"/v1/papers/{short_id}")
    assert latest.status_code == 200, latest.text
    paper = latest.json()
    assert paper["status"] == CORRECTED, paper
    assert paper["n"] == 2, paper
    assert [
        {"id": notice["id"], "kind": notice["kind"], "reason": notice["reason"]}
        for notice in paper["notices"]
    ] == [
        {
            "id": correction_cid,
            "kind": "correction",
            "reason": correction["body"]["reason"],
        }
    ], paper

    for n, version_cid in ((1, v1), (2, v2)):
        response = client.get(f"/v1/papers/{short_id}/v{n}")
        assert response.status_code == 200, response.text
        version_view = response.json()
        assert version_view["n"] == n, version_view
        assert version_view["versionCid"] == version_cid, version_view
        assert version_view["status"] == CORRECTED, version_view
        # The notice belongs to the paper, so it is shown with every version,
        # not only the one the correction named.
        assert [notice["kind"] for notice in version_view["notices"]] == ["correction"], version_view
        assert [notice["id"] for notice in version_view["notices"]] == [correction_cid], version_view
        assert version_view["notices"][0]["reason"] == correction["body"]["reason"], version_view
