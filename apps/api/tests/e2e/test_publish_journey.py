"""Journey: an author publishes a paper end-to-end.

The author uploads a manuscript over tus and signs the three records a
submission is made of -- the file manifest, the paper genesis and version 1.
The two co-authors on the byline then consent.  Scanning passes, a moderator
lists the paper with a signed decision, the paper's ``sch:`` id resolves in the
public catalog, and the node's advisory AI pre-review appears.
"""

from __future__ import annotations

import io

from pypdf import PdfWriter
from scholium_record_core import derive_short_id

from app.modules.ai_review.prompt_set import AGENT_NAMES

from .helpers import Actor, verification_link_for

ORCID_ID = "0000-0002-1825-0097"
PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

#: The states a version passes through on the way to the catalog.
MODERATION = "moderation"
LISTED = "listed"


def upload_pdf(client, data: bytes, *, headers: dict[str, str] | None = None) -> str:
    """Upload ``data`` as a manuscript over tus and return its content id.

    ``headers`` carries the uploading account's ``Authorization``: an upload
    belongs to the DID that creates it, so the same caller must also append.
    """
    auth = dict(headers or {})
    # tus creation
    r = client.post(
        "/v1/uploads",
        headers={
            **auth,
            "Tus-Resumable": "1.0.0",
            "Upload-Length": str(len(data)),
        },
    )
    assert r.status_code == 201, r.text
    loc = r.headers["Location"]
    upload_id = loc.rsplit("/", 1)[-1]
    # patch
    r = client.patch(
        f"/v1/uploads/{upload_id}",
        content=data,
        headers={
            **auth,
            "Tus-Resumable": "1.0.0",
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": "0",
        },
    )
    assert r.status_code == 204, r.text
    cid = r.headers.get("Upload-Cid")
    assert cid, r.headers
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
    # endorse in cs.AI
    endorsement = reviewer.record(
        "endorsement", {"endorsee": author.did, "category": "cs.AI", "statement": "ok"}
    )
    acc = reviewer.submit(endorsement)
    assert acc.status_code == 201, acc.text
    author.refresh()
    assert author.tier == 2
    return author


def blank_pdf() -> bytes:
    """A minimal, valid one-page PDF."""
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_publish_journey(client, node, reviewer):
    from app import jobs
    from app.modules.admin.cli import main as admin_cli
    from app.modules.submissions import get_version

    # A moderator, appointed the way the node operator does it: the admin CLI.
    moderator = Actor(client)
    moderator.sign_in()
    assert admin_cli(["set-tier", moderator.did, "moderator"]) == 0
    moderator.refresh()
    assert moderator.tier == 4

    author = make_author(client, reviewer)

    co1 = Actor(client)
    co1.sign_in()
    co2 = Actor(client)
    co2.sign_in()

    # --- upload the manuscript ----------------------------------------------
    pdf_bytes = blank_pdf()
    cid = upload_pdf(client, pdf_bytes, headers=author.headers)

    # --- sign the manifest, genesis and version -----------------------------
    manifest = author.record(
        "manifest",
        {
            "files": [
                {
                    "path": "main.pdf",
                    "cid": cid,
                    "size": len(pdf_bytes),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    m = author.submit(manifest)
    assert m.status_code == 201, m.text
    manifest_cid = manifest["id"]

    genesis = author.record(
        "paper.genesis",
        {
            "title": "Test Paper",
            "abstract": "abs",
            "categories": ["cs.AI"],
            "licence": "CC-BY-4.0",
            "authors": [author.did, co1.did, co2.did],
        },
    )
    g = author.submit(genesis)
    assert g.status_code == 201, g.text
    genesis_cid = genesis["id"]
    short_id = g.json().get("shortId") or g.json().get("short_id")
    assert short_id and short_id.startswith("sch:"), g.text

    version = author.record(
        "paper.version",
        {
            "paper": genesis_cid,
            "n": 1,
            "title": "Test Paper v1",
            "abstract": "abs v1",
            "authors": [
                {"did": author.did, "position": 1, "creditRoles": ["Conceptualization"]},
                {"did": co1.did, "position": 2, "creditRoles": ["Conceptualization"]},
                {"did": co2.did, "position": 3, "creditRoles": ["Conceptualization"]},
            ],
            "manifest": manifest_cid,
            "licence": "CC-BY-4.0",
            "changeNote": "v1",
        },
        prev=genesis_cid,
    )
    v = author.submit(version)
    assert v.status_code == 201, v.text
    version_cid = version["id"]

    # --- both co-authors (and the author) consent ---------------------------
    for actor in (author, co1, co2):
        consent = actor.record(
            "coauthor.consent",
            {"version": version_cid, "role": "Conceptualization", "decision": "accept"},
        )
        c = actor.submit(consent)
        assert c.status_code == 201, c.text

    # The round completing moves the version to scanning; the eager scan job
    # then passes it to moderation.
    jobs.run_pending()
    row = get_version(version_cid)
    assert row is not None
    assert row.state == MODERATION, row.state

    # --- scanning passed and the version is in the moderator's queue --------
    q = client.get("/v1/moderation/queue", headers=moderator.headers)
    assert q.status_code == 200, q.text
    queued = {item["version_cid"]: item for item in q.json()}
    assert version_cid in queued, q.text
    assert queued[version_cid]["scan_result"] == "passed", queued[version_cid]
    assert queued[version_cid]["short_id"] == short_id, queued[version_cid]

    # --- a moderator lists the paper ----------------------------------------
    policies = client.get("/v1/moderation/policies")
    assert policies.status_code == 200, policies.text
    clause_id = policies.json()[0]["id"]

    decision = moderator.record(
        "moderation.decision",
        {
            "target": version_cid,
            "action": "list",
            "clause": clause_id,
            "reason": "ok",
        },
    )
    d = moderator.submit(decision)
    assert d.status_code == 201, d.text
    assert d.json()["state"] == LISTED, d.text

    row = get_version(version_cid)
    assert row is not None
    assert row.state == LISTED, row.state

    # --- the sch: id resolves in the public catalog -------------------------
    sid = derive_short_id(genesis_cid)
    r = client.get(f"/v1/papers/{sid}")
    assert r.status_code == 200, r.text
    paper = r.json()
    assert paper["shortId"] == sid, paper
    assert paper["paperCid"] == genesis_cid, paper
    assert paper["versionCid"] == version_cid, paper
    assert paper["title"] == "Test Paper v1", paper
    assert [a["did"] for a in paper["authors"]] == [author.did, co1.did, co2.did], paper

    # --- the fake-provider AI pre-review appears ----------------------------
    jobs.run_pending()
    r = client.get(f"/v1/papers/{sid}/ai-reviews")
    assert r.status_code == 200, r.text
    review = r.json()
    assert review["advisory"] is True, review
    assert review["versionCid"] == version_cid, review
    assert {group["agent"] for group in review["agents"]} == set(AGENT_NAMES), review
    assert {model["provider"] for model in review["models"]} == {"fake"}, review
