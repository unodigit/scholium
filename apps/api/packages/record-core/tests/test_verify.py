"""Tests for whole-paper verification (``verify_paper``)."""

import copy
import json
import random
from dataclasses import dataclass, field

import pytest
from nacl.signing import SigningKey

from scholium_record_core import (
    CHECK_NAMES,
    STATUS_CORRECTED,
    STATUS_INVALID,
    STATUS_RETRACTED,
    STATUS_TOMBSTONED,
    STATUS_VERIFIED,
    STATUSES,
    CheckResult,
    VerificationReport,
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    format_version_id,
    sign_record,
    verify_paper,
)

KEYS = {
    name: SigningKey(bytes([index]) * 32)
    for index, name in enumerate(
        ["alice", "bob", "carol", "mallory", "committee", "dave"], start=1
    )
}


def did(name):
    return did_key_from_signing_key(KEYS[name])


def signed(name, record_type, body, prev=None, created="2026-11-14T05:33:00Z"):
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did(name),
            "created": created,
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        KEYS[name],
    )


def file_entry(path, data):
    return {
        "path": path,
        "cid": compute_file_id(data),
        "size": len(data),
        "mediaType": "application/pdf",
        "role": "manuscript",
    }


@dataclass
class Paper:
    genesis: dict
    versions: list = field(default_factory=list)
    manifests: list = field(default_factory=list)
    consents: list = field(default_factory=list)  # one list per version
    extra: list = field(default_factory=list)

    @property
    def paper_id(self):
        return self.genesis["id"]

    @property
    def short_id(self):
        return derive_short_id(self.paper_id)

    def records(self):
        flat = [self.genesis]
        for index, version in enumerate(self.versions):
            flat.append(self.manifests[index])
            flat.append(version)
            flat.extend(self.consents[index])
        return flat + self.extra


def add_version(paper, authors=("alice", "bob"), submitter="alice", consent=True):
    n = len(paper.versions) + 1
    prev = paper.versions[-1]["id"] if paper.versions else paper.paper_id
    manifest = signed(
        submitter,
        "manifest",
        {"files": [file_entry(f"main-v{n}.pdf", f"manuscript v{n}".encode())]},
    )
    version = signed(
        submitter,
        "paper.version",
        {
            "paper": paper.paper_id,
            "n": n,
            "title": f"A Paper, version {n}",
            "abstract": "Abstract.",
            "authors": [{"did": did(a), "credit": ["writing"]} for a in authors],
            "manifest": manifest["id"],
            "licence": "CC-BY-4.0",
            "changeNote": f"change {n}",
        },
        prev=prev,
    )
    paper.manifests.append(manifest)
    paper.versions.append(version)
    paper.consents.append(
        [
            signed(
                a,
                "coauthor.consent",
                {"version": version["id"], "role": "author", "decision": "accept"},
            )
            for a in authors
        ]
        if consent
        else []
    )
    return version


def make_paper(versions=1, authors=("alice", "bob"), seed="s-1"):
    genesis = signed(
        "alice",
        "paper.genesis",
        {"seed": seed, "title": "A Paper", "categories": ["math"], "licence": "CC-BY-4.0"},
    )
    paper = Paper(genesis)
    for _ in range(versions):
        add_version(paper, authors)
    return paper


def notice(name, record_type, target, **body):
    return signed(name, record_type, {"target": target, "reason": "r", **body})


def tombstone(name, target):
    return signed(
        name,
        "moderation.decision",
        {"target": target, "action": "tombstone", "clause": "MOD-09", "reasonCid": "x"},
    )


def tampered(record, **body_changes):
    """A copy of ``record`` whose body changed but id and sig did not."""
    forged = copy.deepcopy(record)
    forged["body"].update(body_changes)
    return forged


def swap(records, old, new):
    return [new if r is old else r for r in records]


def failed(report):
    return sorted(name for name, check in report.checks.items() if not check.passed)


# --- the happy path -----------------------------------------------------


def test_verifies_a_single_version_paper():
    paper = make_paper()
    report = verify_paper(paper.records())
    assert isinstance(report, VerificationReport)
    assert report.status == STATUS_VERIFIED
    assert report.valid
    assert report.version_count == 1
    assert report.genesis == paper.paper_id
    assert report.head == paper.versions[0]["id"]
    assert report.short_id == paper.short_id
    assert report.authors == (did("alice"), did("bob"))
    assert report.supersessions == ()
    assert failed(report) == []


def test_report_carries_every_check_in_order_with_messages():
    report = verify_paper(make_paper().records())
    assert tuple(report.checks) == CHECK_NAMES
    for name, check in report.checks.items():
        assert isinstance(check, CheckResult)
        assert check.name == name
        assert check.passed is True
        assert check and check.message
        assert check.details == ()


def test_signers_are_everyone_who_signed_the_chain_in_order():
    paper = make_paper(authors=("alice", "bob", "carol"))
    report = verify_paper(paper.records())
    assert report.signers == (did("alice"), did("bob"), did("carol"))


def test_signers_cover_authors_of_every_version():
    paper = make_paper(versions=1, authors=("alice", "bob"))
    add_version(paper, authors=("alice", "carol"), submitter="carol")
    report = verify_paper(paper.records())
    # first appearance, genesis to head: v1 brings alice and bob, v2 carol
    assert report.signers == (did("alice"), did("bob"), did("carol"))
    assert report.authors == (did("alice"), did("carol"))


def test_follows_prev_links_from_newest_version_to_genesis():
    paper = make_paper(versions=4)
    report = verify_paper(paper.records())
    assert report.status == STATUS_VERIFIED
    assert report.version_count == 4
    assert report.head == paper.versions[-1]["id"]
    assert "v1 → v4" in report.checks["chain"].message


def test_record_order_does_not_matter():
    paper = make_paper(versions=3)
    expected = verify_paper(paper.records())
    records = paper.records()
    for seed in range(5):
        random.Random(seed).shuffle(records)
        assert verify_paper(records) == expected


def test_accepts_any_iterable_and_ignores_exact_duplicates():
    paper = make_paper(versions=2)
    expected = verify_paper(paper.records())
    assert verify_paper(iter(paper.records())) == expected
    assert verify_paper(paper.records() + paper.records()) == expected


def test_unrelated_records_and_other_papers_are_ignored():
    paper = make_paper(versions=2)
    other = make_paper(versions=3, seed="other")
    noise = [
        signed("dave", "discussion.post", {"target": paper.versions[0]["id"], "text": "hi"}),
        signed("dave", "review.rating", {"review": "x", "rating": 4}),
        signed("dave", "withdrawal", {"target": paper.paper_id}),
    ]
    report = verify_paper(
        paper.records() + other.records() + noise, paper=paper.paper_id
    )
    assert report.status == STATUS_VERIFIED
    assert report.version_count == 2
    assert report.supersessions == ()


def test_to_dict_is_json_serializable_and_complete():
    paper = make_paper()
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    data = verify_paper(paper.records()).to_dict()
    assert json.loads(json.dumps(data)) == data
    assert set(data) == {
        "status",
        "valid",
        "short_id",
        "genesis",
        "head",
        "version_count",
        "signers",
        "authors",
        "checks",
        "supersessions",
    }
    assert list(data["checks"]) == list(CHECK_NAMES)
    assert data["checks"]["chain"]["passed"] is True
    assert data["supersessions"][0]["kind"] == "correction"


def test_statuses_vocabulary():
    assert set(STATUSES) == {
        STATUS_VERIFIED,
        STATUS_CORRECTED,
        STATUS_RETRACTED,
        STATUS_TOMBSTONED,
        STATUS_INVALID,
    }


# --- choosing the paper and the head -------------------------------------


def test_verifying_an_earlier_version_by_record_id():
    paper = make_paper(versions=3)
    report = verify_paper(paper.records(), head=paper.versions[1]["id"])
    assert report.status == STATUS_VERIFIED
    assert report.version_count == 2
    assert report.head == paper.versions[1]["id"]
    assert report.authors == (did("alice"), did("bob"))


def test_verifying_a_version_by_sch_id():
    paper = make_paper(versions=3)
    version_id = format_version_id(paper.short_id, 2)
    report = verify_paper(paper.records(), head=version_id)
    assert report.status == STATUS_VERIFIED
    assert report.version_count == 2
    assert report.head == paper.versions[1]["id"]


def test_paper_can_be_named_by_short_id_or_genesis_record_id():
    first = make_paper(versions=1, seed="first")
    second = make_paper(versions=2, seed="second")
    records = first.records() + second.records()
    assert verify_paper(records, paper=second.short_id).version_count == 2
    assert verify_paper(records, paper=second.paper_id).version_count == 2
    assert verify_paper(records, paper=first.short_id.upper()).version_count == 1


def test_several_papers_without_a_choice_is_a_chain_failure_not_a_guess():
    first = make_paper(seed="first")
    second = make_paper(seed="second")
    report = verify_paper(first.records() + second.records())
    assert report.status == STATUS_INVALID
    assert "2 papers" in report.checks["chain"].message
    assert report.version_count == 0
    assert report.genesis is None


def test_a_version_id_alone_selects_the_paper():
    first = make_paper(versions=2, seed="first")
    second = make_paper(versions=3, seed="second")
    report = verify_paper(
        first.records() + second.records(), head=second.versions[1]["id"]
    )
    assert report.status == STATUS_VERIFIED
    assert report.genesis == second.paper_id
    assert report.version_count == 2

    by_sch = verify_paper(
        first.records() + second.records(),
        head=format_version_id(first.short_id, 1),
    )
    assert by_sch.genesis == first.paper_id
    assert by_sch.version_count == 1


def test_unknown_head_or_paper_fails_the_chain():
    paper = make_paper(versions=2)
    other = make_paper(seed="elsewhere")
    assert (
        verify_paper(paper.records(), head=other.versions[0]["id"]).status
        == STATUS_INVALID
    )
    assert (
        verify_paper(paper.records(), head=format_version_id(paper.short_id, 9)).status
        == STATUS_INVALID
    )
    assert verify_paper(paper.records(), paper=other.short_id).status == STATUS_INVALID
    assert verify_paper(paper.records(), paper=other.paper_id).status == STATUS_INVALID


def test_head_that_is_the_genesis_or_not_a_version_fails():
    paper = make_paper()
    for head in (paper.paper_id, paper.manifests[0]["id"], paper.consents[0][0]["id"]):
        report = verify_paper(paper.records(), paper=paper.paper_id, head=head)
        assert report.status == STATUS_INVALID, head
        assert not report.checks["chain"].passed


# --- tampering ----------------------------------------------------------


def test_tampered_head_body_fails_signature_check():
    paper = make_paper(versions=2)
    head = paper.versions[-1]
    records = swap(paper.records(), head, tampered(head, title="Forged title"))
    report = verify_paper(records)
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed
    assert head["id"] in report.checks["signatures"].details[0]
    assert report.checks["chain"].passed  # the shape is fine; the content is not


def test_tampered_older_version_fails_signature_and_prev_hash_checks():
    paper = make_paper(versions=3)
    victim = paper.versions[0]
    records = swap(paper.records(), victim, tampered(victim, title="Rewritten"))
    report = verify_paper(records)
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed
    assert not report.checks["prev_hashes"].passed
    assert "hashes to" in report.checks["prev_hashes"].details[0]


def test_tampered_genesis_fails_signature_and_prev_hash_checks():
    paper = make_paper(versions=2)
    records = swap(
        paper.records(), paper.genesis, tampered(paper.genesis, title="Not mine")
    )
    report = verify_paper(records, paper=paper.paper_id)
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed
    assert not report.checks["prev_hashes"].passed


def test_unsigned_or_wrong_key_signature_fails():
    paper = make_paper()
    head = paper.versions[0]
    wrong_key = copy.deepcopy(head)
    wrong_key["sig"] = signed("mallory", "paper.version", head["body"])["sig"]
    unsigned = {k: v for k, v in head.items() if k != "sig"}
    for forged, why in ((wrong_key, "signature does not verify"), (unsigned, "no signature")):
        report = verify_paper(swap(paper.records(), head, forged))
        assert report.status == STATUS_INVALID
        assert not report.checks["signatures"].passed
        assert why in report.checks["signatures"].details[0]


def test_a_record_with_a_wrong_id_fails_signatures():
    paper = make_paper()
    consent = paper.consents[0][0]
    wrong_id = {**consent, "id": paper.genesis["id"]}
    report = verify_paper(swap(paper.records(), consent, wrong_id))
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed


def test_two_different_records_claiming_one_id_fail_closed():
    paper = make_paper()
    head = paper.versions[0]
    impostor = tampered(head, title="Impostor")
    for records in (
        paper.records() + [impostor],
        [impostor] + paper.records(),
    ):
        report = verify_paper(records)
        assert report.status == STATUS_INVALID
        assert not report.checks["signatures"].passed


def test_missing_genesis_fails_the_chain():
    paper = make_paper(versions=2)
    records = [r for r in paper.records() if r is not paper.genesis]
    report = verify_paper(records)
    assert report.status == STATUS_INVALID
    assert not report.checks["chain"].passed
    assert "paper.genesis" in report.checks["chain"].message
    assert report.genesis == paper.paper_id
    assert report.version_count == 2


def test_missing_middle_version_fails_the_chain():
    paper = make_paper(versions=3)
    records = [r for r in paper.records() if r is not paper.versions[1]]
    report = verify_paper(records)
    assert report.status == STATUS_INVALID
    assert not report.checks["chain"].passed
    # v1 and v3 are both unfollowed, but the gap is named, not mistaken for a fork
    assert paper.versions[1]["id"] in report.checks["chain"].message
    assert report.version_count == 0

    named = verify_paper(records, head=paper.versions[2]["id"])
    assert named.status == STATUS_INVALID
    assert paper.versions[1]["id"] in named.checks["chain"].message
    assert named.version_count == 1  # only the head itself could be followed
    # v3 itself is intact, but its link to the absent v2 cannot be checked
    assert named.checks["signatures"].passed
    assert not named.checks["prev_hashes"].passed
    assert "cannot be checked" in named.checks["prev_hashes"].details[0]


def test_missing_newest_version_is_indistinguishable_from_an_older_head():
    """Dropping the newest version leaves a valid shorter paper.

    A verifier cannot know what it was never given; the node's signed log
    head and anchors are what detect that.  What it *can* do is not hide
    a corrupted newest version, tested above.
    """
    paper = make_paper(versions=3)
    records = [r for r in paper.records() if r is not paper.versions[2]]
    assert verify_paper(records).version_count == 2


def test_version_with_a_gap_in_numbering_fails():
    paper = make_paper(versions=1)
    skipping = signed(
        "alice",
        "paper.version",
        {**paper.versions[0]["body"], "n": 3},
        prev=paper.versions[0]["id"],
    )
    paper.versions.append(skipping)
    paper.manifests.append(paper.manifests[0])
    paper.consents.append([])
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert "n=3, expected 2" in report.checks["chain"].details[0]


def test_first_version_must_be_numbered_one():
    paper = make_paper(versions=0)
    version = signed(
        "alice",
        "paper.version",
        {
            "paper": paper.paper_id,
            "n": 2,
            "title": "t",
            "authors": [{"did": did("alice")}],
            "manifest": "x",
        },
        prev=paper.paper_id,
    )
    report = verify_paper([paper.genesis, version])
    assert report.status == STATUS_INVALID
    assert "n=2, expected 1" in "".join(report.checks["chain"].details)


def test_version_with_null_prev_fails():
    paper = make_paper(versions=1)
    detached = signed("alice", "paper.version", paper.versions[0]["body"], prev=None)
    report = verify_paper([paper.genesis, detached], paper=paper.paper_id)
    assert report.status == STATUS_INVALID
    assert "no prev link" in report.checks["chain"].message


def test_version_of_another_paper_cannot_be_spliced_in():
    paper = make_paper(versions=1)
    other = make_paper(versions=1, seed="other")
    spliced = signed(
        "alice",
        "paper.version",
        {**paper.versions[0]["body"], "n": 2},
        prev=other.versions[0]["id"],
    )
    records = paper.records() + other.records() + [spliced]
    report = verify_paper(records, paper=paper.paper_id, head=spliced["id"])
    assert report.status == STATUS_INVALID
    assert not report.checks["chain"].passed


def test_genesis_must_have_null_prev():
    paper = make_paper(versions=1)
    bad_genesis = signed("alice", "paper.genesis", paper.genesis["body"], prev=paper.paper_id)
    version = signed(
        "alice",
        "paper.version",
        paper.versions[0]["body"] | {"paper": bad_genesis["id"]},
        prev=bad_genesis["id"],
    )
    report = verify_paper(
        [bad_genesis, version, paper.manifests[0]] + paper.consents[0],
        paper=bad_genesis["id"],
    )
    assert report.status == STATUS_INVALID
    assert "prev null" in report.checks["chain"].message


def test_prev_cycle_is_detected_and_does_not_hang():
    # Records with ids that do not match their content can claim any prev.
    a = make_paper(seed="a").versions[0]
    b = make_paper(seed="b").versions[0]
    genesis = make_paper(seed="g").genesis
    a_loop = {**a, "prev": b["id"], "body": {**a["body"], "paper": genesis["id"]}}
    b_loop = {**b, "prev": a["id"], "body": {**b["body"], "paper": genesis["id"]}}
    report = verify_paper([genesis, a_loop, b_loop], paper=genesis["id"])
    assert report.status == STATUS_INVALID
    assert "cycle" in report.checks["chain"].message
    report = verify_paper(
        [genesis, a_loop, b_loop], paper=genesis["id"], head=a["id"]
    )
    assert report.status == STATUS_INVALID
    assert "loop" in report.checks["chain"].message


def test_forked_versions_are_competing_heads_not_a_guess():
    paper = make_paper(versions=1)
    fork = add_version(paper)  # v2
    sibling = signed(
        "alice",
        "paper.version",
        {**fork["body"], "title": "The other v2"},
        prev=paper.versions[0]["id"],
    )
    paper.extra += [sibling] + [
        signed(
            a,
            "coauthor.consent",
            {"version": sibling["id"], "role": "author", "decision": "accept"},
        )
        for a in ("alice", "bob")
    ]
    paper.extra.append(paper.manifests[1])
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert "competing heads" in report.checks["chain"].message
    # Naming the version resolves it, either way round.
    assert verify_paper(paper.records(), head=fork["id"]).status == STATUS_VERIFIED
    assert verify_paper(paper.records(), head=sibling["id"]).status == STATUS_VERIFIED
    ambiguous = verify_paper(paper.records(), head=format_version_id(paper.short_id, 2))
    assert ambiguous.status == STATUS_INVALID


def test_a_corrupted_newest_version_does_not_fall_back_to_an_older_head():
    paper = make_paper(versions=2)
    newest = paper.versions[-1]
    corrupted = copy.deepcopy(newest)
    corrupted["body"]["n"] = 7
    report = verify_paper(swap(paper.records(), newest, corrupted))
    assert report.status == STATUS_INVALID
    assert report.head == newest["id"]


# --- consents -----------------------------------------------------------


def test_missing_consent_from_a_listed_author_fails():
    paper = make_paper(authors=("alice", "bob", "carol"))
    bobs = paper.consents[0][1]
    records = [r for r in paper.records() if r is not bobs]
    report = verify_paper(records)
    assert report.status == STATUS_INVALID
    assert failed(report) == ["consents"]
    assert report.checks["consents"].details == (
        f"version {paper.versions[0]['id']}: no consent from {did('bob')}",
    )


def test_the_submitting_author_must_consent_too():
    paper = make_paper(authors=("alice", "bob"))
    alices = paper.consents[0][0]
    report = verify_paper([r for r in paper.records() if r is not alices])
    assert failed(report) == ["consents"]
    assert did("alice") in report.checks["consents"].details[0]


def test_a_decline_fails_and_names_the_decliner():
    paper = make_paper(authors=("alice", "bob"))
    declined = signed(
        "bob",
        "coauthor.consent",
        {"version": paper.versions[0]["id"], "role": "author", "decision": "decline"},
    )
    paper.consents[0][1] = declined
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert report.checks["consents"].details == (
        f"version {paper.versions[0]['id']}: declined by {did('bob')}",
    )


def test_a_decline_beats_an_accept_from_the_same_author():
    paper = make_paper(authors=("alice", "bob"))
    paper.extra.append(
        signed(
            "bob",
            "coauthor.consent",
            {"version": paper.versions[0]["id"], "role": "author", "decision": "decline"},
        )
    )
    report = verify_paper(paper.records())
    assert failed(report) == ["consents"]
    assert "declined by" in report.checks["consents"].details[0]


def test_consent_by_someone_not_listed_does_not_count():
    paper = make_paper(authors=("alice", "bob"))
    bobs = paper.consents[0][1]
    mallory = signed(
        "mallory",
        "coauthor.consent",
        {"version": paper.versions[0]["id"], "role": "author", "decision": "accept"},
    )
    report = verify_paper(swap(paper.records(), bobs, mallory))
    assert failed(report) == ["consents"]
    assert did("mallory") not in report.signers


def test_consent_for_another_version_does_not_count():
    paper = make_paper(versions=2)
    v1_consent = paper.consents[0][1]
    v2_consent = paper.consents[1][1]
    # bob's consent to v2 is replaced by an (authentic) consent to v1 again
    report = verify_paper(swap(paper.records(), v2_consent, copy.deepcopy(v1_consent)))
    assert failed(report) == ["consents"]
    assert paper.versions[1]["id"] in report.checks["consents"].details[0]


def test_every_version_needs_its_own_consents():
    paper = make_paper(versions=2)
    consent_for_v2 = paper.consents[1][0]
    report = verify_paper([r for r in paper.records() if r is not consent_for_v2])
    assert failed(report) == ["consents"]
    assert paper.versions[1]["id"] in report.checks["consents"].details[0]


@pytest.mark.parametrize("decision", [None, "yes", "ACCEPT", "", 1, True])
def test_consent_needs_an_explicit_accept(decision):
    paper = make_paper(authors=("alice", "bob"))
    bobs = paper.consents[0][1]
    body = {"version": paper.versions[0]["id"], "role": "author"}
    if decision is not None:
        body["decision"] = decision
    odd = signed("bob", "coauthor.consent", body)
    report = verify_paper(swap(paper.records(), bobs, odd))
    assert failed(report) == ["consents"]


def test_forged_consent_fails_signatures_and_does_not_count():
    paper = make_paper(authors=("alice", "bob"))
    bobs = paper.consents[0][1]
    forged = copy.deepcopy(bobs)
    forged["sig"] = paper.consents[0][0]["sig"]  # alice's signature on bob's consent
    report = verify_paper(swap(paper.records(), bobs, forged))
    assert report.status == STATUS_INVALID
    assert failed(report) == ["consents", "signatures"]
    assert bobs["id"] in report.checks["signatures"].details[0]
    assert did("bob") not in report.signers


def test_tampered_consent_fails_even_when_a_good_copy_is_present():
    paper = make_paper(authors=("alice", "bob"))
    bobs = paper.consents[0][1]
    paper.extra.append(tampered(bobs, role="reviewer"))
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed
    assert report.checks["consents"].passed  # the good copy still counts


@pytest.mark.parametrize(
    "authors, problem",
    [
        (None, "must be a list"),
        ([], "at least one author"),
        ("alice", "must be a list"),
        ([{"name": "alice"}], "authors[0].did"),
        (["did:key:z6Mk"], "authors[0].did"),
        ([{"did": "did:web:example.org"}], "authors[0].did"),
    ],
)
def test_version_authors_must_be_listed_as_ed25519_dids(authors, problem):
    paper = make_paper(versions=0)
    body = {"paper": paper.paper_id, "n": 1, "title": "t", "manifest": "x"}
    if authors is not None:
        body["authors"] = authors
    version = signed("alice", "paper.version", body, prev=paper.paper_id)
    report = verify_paper([paper.genesis, version])
    assert report.status == STATUS_INVALID
    assert problem in report.checks["consents"].message


def test_duplicate_listed_authors_need_one_consent():
    paper = make_paper(versions=0)
    add_version(paper, authors=("alice", "bob", "bob"))
    assert len(paper.consents[0]) == 3
    paper.consents[0].pop()  # only two distinct consents remain
    report = verify_paper(paper.records())
    assert report.status == STATUS_VERIFIED
    assert report.authors == (did("alice"), did("bob"))


# --- manifests ----------------------------------------------------------


def test_missing_manifest_record_fails():
    paper = make_paper()
    report = verify_paper([r for r in paper.records() if r is not paper.manifests[0]])
    assert report.status == STATUS_INVALID
    assert failed(report) == ["manifests"]
    assert paper.manifests[0]["id"] in report.checks["manifests"].message


def test_version_without_a_manifest_reference_fails():
    paper = make_paper(versions=0)
    body = {
        "paper": paper.paper_id,
        "n": 1,
        "title": "t",
        "authors": [{"did": did("alice")}],
    }
    version = signed("alice", "paper.version", body, prev=paper.paper_id)
    consent = signed(
        "alice",
        "coauthor.consent",
        {"version": version["id"], "role": "author", "decision": "accept"},
    )
    report = verify_paper([paper.genesis, version, consent])
    assert failed(report) == ["manifests"]
    assert "names no manifest" in report.checks["manifests"].message


def test_invalid_manifest_body_fails():
    paper = make_paper(versions=0)
    bad = signed("alice", "manifest", {"files": []})
    version = signed(
        "alice",
        "paper.version",
        {
            "paper": paper.paper_id,
            "n": 1,
            "title": "t",
            "authors": [{"did": did("alice")}],
            "manifest": bad["id"],
        },
        prev=paper.paper_id,
    )
    consent = signed(
        "alice",
        "coauthor.consent",
        {"version": version["id"], "role": "author", "decision": "accept"},
    )
    report = verify_paper([paper.genesis, bad, version, consent])
    assert failed(report) == ["manifests"]
    assert "at least one file" in report.checks["manifests"].message


def test_manifest_reference_to_a_record_of_another_type_fails():
    paper = make_paper(versions=0)
    not_a_manifest = signed("alice", "discussion.post", {"text": "hello"})
    version = signed(
        "alice",
        "paper.version",
        {
            "paper": paper.paper_id,
            "n": 1,
            "title": "t",
            "authors": [{"did": did("alice")}],
            "manifest": not_a_manifest["id"],
        },
        prev=paper.paper_id,
    )
    consent = signed(
        "alice",
        "coauthor.consent",
        {"version": version["id"], "role": "author", "decision": "accept"},
    )
    report = verify_paper([paper.genesis, not_a_manifest, version, consent])
    assert failed(report) == ["manifests"]
    assert "not a manifest" in report.checks["manifests"].message


def test_tampered_manifest_fails_signatures():
    paper = make_paper()
    manifest = paper.manifests[0]
    forged = copy.deepcopy(manifest)
    forged["body"]["files"][0]["size"] += 1
    report = verify_paper(swap(paper.records(), manifest, forged))
    assert report.status == STATUS_INVALID
    assert not report.checks["signatures"].passed


# --- supersession -------------------------------------------------------


def test_retraction_by_the_submitting_author_retracts_the_paper():
    paper = make_paper(versions=2)
    retraction = notice("alice", "retraction", paper.paper_id, replacement=None)
    paper.extra.append(retraction)
    report = verify_paper(paper.records())
    assert report.status == STATUS_RETRACTED
    assert report.valid  # the history still verifies
    assert failed(report) == []
    (item,) = report.supersessions
    assert (item.kind, item.id, item.author) == ("retraction", retraction["id"], did("alice"))
    assert (item.scope, item.applied, item.reason) == ("paper", True, None)
    assert "1 retraction" in report.checks["supersession"].message


def test_retraction_by_a_co_author_who_did_not_submit_applies():
    paper = make_paper()
    paper.extra.append(notice("bob", "retraction", paper.paper_id))
    assert verify_paper(paper.records()).status == STATUS_RETRACTED


def test_retraction_of_one_version_applies_to_the_whole_paper():
    paper = make_paper(versions=3)
    paper.extra.append(notice("alice", "retraction", paper.versions[0]["id"]))
    for head in (None, paper.versions[0]["id"], paper.versions[2]["id"]):
        report = verify_paper(paper.records(), head=head)
        assert report.status == STATUS_RETRACTED, head
        assert report.supersessions[0].scope == "version"


def test_retraction_by_an_outsider_is_reported_but_not_applied():
    paper = make_paper()
    paper.extra.append(notice("mallory", "retraction", paper.paper_id))
    report = verify_paper(paper.records())
    assert report.status == STATUS_VERIFIED
    (item,) = report.supersessions
    assert not item.applied
    assert "neither an author" in item.reason
    assert report.checks["supersession"].passed
    assert "No retraction" in report.checks["supersession"].message


def test_retraction_by_a_trusted_authority_applies():
    paper = make_paper()
    paper.extra.append(notice("committee", "retraction", paper.paper_id))
    assert verify_paper(paper.records()).status == STATUS_VERIFIED
    report = verify_paper(paper.records(), authorities=[did("committee")])
    assert report.status == STATUS_RETRACTED
    assert report.supersessions[0].applied


def test_a_non_author_who_is_not_a_signer_of_the_paper_is_not_a_signer():
    paper = make_paper()
    paper.extra.append(notice("committee", "retraction", paper.paper_id))
    report = verify_paper(paper.records(), authorities=[did("committee")])
    assert did("committee") not in report.signers


def test_correction_marks_the_paper_corrected():
    paper = make_paper(versions=2)
    paper.extra.append(
        notice("alice", "correction", paper.versions[0]["id"], replacement=paper.versions[1]["id"])
    )
    report = verify_paper(paper.records())
    assert report.status == STATUS_CORRECTED
    assert report.valid
    assert report.supersessions[0].kind == "correction"
    assert "1 correction" in report.checks["supersession"].message


def test_correction_by_an_outsider_does_not_apply():
    paper = make_paper()
    paper.extra.append(notice("mallory", "correction", paper.paper_id))
    assert verify_paper(paper.records()).status == STATUS_VERIFIED


def test_retraction_outranks_tombstone_outranks_correction():
    paper = make_paper()
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    authorities = [did("committee")]
    assert verify_paper(paper.records(), authorities=authorities).status == STATUS_CORRECTED
    paper.extra.append(tombstone("committee", paper.paper_id))
    assert verify_paper(paper.records(), authorities=authorities).status == STATUS_TOMBSTONED
    paper.extra.append(notice("alice", "retraction", paper.paper_id))
    report = verify_paper(paper.records(), authorities=authorities)
    assert report.status == STATUS_RETRACTED
    assert [s.kind for s in report.supersessions] == ["correction", "retraction", "tombstone"]
    assert all(s.applied for s in report.supersessions)


def test_tombstone_by_an_authority_tombstones_but_history_still_verifies():
    paper = make_paper(versions=2)
    paper.extra.append(tombstone("committee", paper.paper_id))
    report = verify_paper(paper.records(), authorities=[did("committee")])
    assert report.status == STATUS_TOMBSTONED
    assert report.valid
    assert failed(report) == []
    assert report.version_count == 2
    assert report.supersessions[0].scope == "paper"


def test_tombstone_without_authority_is_only_advisory():
    paper = make_paper()
    paper.extra.append(tombstone("committee", paper.paper_id))
    report = verify_paper(paper.records())  # committee is not trusted
    assert report.status == STATUS_VERIFIED
    (item,) = report.supersessions
    assert not item.applied
    assert "advisory" in item.reason


def test_authors_cannot_tombstone_their_own_paper():
    paper = make_paper()
    paper.extra.append(tombstone("alice", paper.paper_id))
    report = verify_paper(paper.records())
    assert report.status == STATUS_VERIFIED
    assert not report.supersessions[0].applied


def test_tombstone_of_the_verified_version_applies():
    paper = make_paper(versions=2)
    paper.extra.append(tombstone("committee", paper.versions[1]["id"]))
    report = verify_paper(paper.records(), authorities=[did("committee")])
    assert report.status == STATUS_TOMBSTONED
    assert report.supersessions[0].scope == "version"


def test_tombstone_of_an_earlier_version_does_not_change_the_head_status():
    paper = make_paper(versions=2)
    paper.extra.append(tombstone("committee", paper.versions[0]["id"]))
    authorities = [did("committee")]
    newest = verify_paper(paper.records(), authorities=authorities)
    assert newest.status == STATUS_VERIFIED
    (item,) = newest.supersessions
    assert not item.applied
    assert "earlier version" in item.reason
    older = verify_paper(paper.records(), head=paper.versions[0]["id"], authorities=authorities)
    assert older.status == STATUS_TOMBSTONED


def test_tombstone_of_a_file_applies_only_to_versions_listing_it():
    paper = make_paper(versions=2)
    v1_file = paper.manifests[0]["body"]["files"][0]["cid"]
    v2_file = paper.manifests[1]["body"]["files"][0]["cid"]
    authorities = [did("committee")]

    paper.extra.append(tombstone("committee", v1_file))
    newest = verify_paper(paper.records(), authorities=authorities)
    assert newest.status == STATUS_VERIFIED
    assert newest.supersessions[0].scope == "file"
    assert not newest.supersessions[0].applied
    older = verify_paper(paper.records(), head=paper.versions[0]["id"], authorities=authorities)
    assert older.status == STATUS_TOMBSTONED

    paper.extra.append(tombstone("committee", v2_file))
    assert verify_paper(paper.records(), authorities=authorities).status == STATUS_TOMBSTONED


def test_moderation_decisions_other_than_tombstone_are_ignored():
    paper = make_paper()
    paper.extra.append(
        signed(
            "committee",
            "moderation.decision",
            {"target": paper.paper_id, "action": "hold", "clause": "MOD-01"},
        )
    )
    report = verify_paper(paper.records(), authorities=[did("committee")])
    assert report.status == STATUS_VERIFIED
    assert report.supersessions == ()


def test_notices_for_other_papers_or_unknown_targets_are_ignored():
    paper = make_paper()
    other = make_paper(seed="other")
    paper.extra.append(notice("alice", "retraction", other.paper_id))
    paper.extra.append(notice("alice", "retraction", other.versions[0]["id"]))
    paper.extra.append(notice("alice", "retraction", "not-a-record-id"))
    paper.extra.append(
        signed("alice", "retraction", {"reason": "no target at all"})
    )
    report = verify_paper(paper.records() + other.records(), paper=paper.paper_id)
    assert report.status == STATUS_VERIFIED
    assert report.supersessions == ()


def test_forged_retraction_fails_the_supersession_check_instead_of_vanishing():
    paper = make_paper()
    real = notice("alice", "retraction", paper.paper_id)
    forged = copy.deepcopy(real)
    forged["sig"] = notice("mallory", "retraction", paper.paper_id)["sig"]
    paper.extra.append(forged)
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert failed(report) == ["supersession"]
    assert real["id"] in report.checks["supersession"].details[0]
    (item,) = report.supersessions
    assert not item.applied
    assert item.reason.startswith("not authentic")


def test_a_retraction_tampered_after_signing_is_not_silently_dropped():
    paper = make_paper()
    paper.extra.append(
        tampered(notice("alice", "retraction", paper.paper_id), reason="changed")
    )
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert failed(report) == ["supersession"]


def test_a_broken_chain_stays_invalid_whatever_the_notices_say():
    paper = make_paper(versions=2)
    paper.extra.append(notice("alice", "retraction", paper.paper_id))
    head = paper.versions[-1]
    records = swap(paper.records(), head, tampered(head, title="x"))
    assert verify_paper(records).status == STATUS_INVALID


# --- degenerate and hostile input ----------------------------------------


def test_no_records_is_invalid_not_an_error():
    report = verify_paper([])
    assert report.status == STATUS_INVALID
    assert not report.valid
    assert report.version_count == 0
    assert report.signers == ()
    assert report.head is None
    assert tuple(report.checks) == CHECK_NAMES
    assert not any(report.checks.values())
    for name in CHECK_NAMES[1:]:
        assert report.checks[name].message.startswith("Not checked")


def test_a_paper_with_only_a_genesis_is_invalid():
    paper = make_paper(versions=0)
    report = verify_paper(paper.records())
    assert report.status == STATUS_INVALID
    assert "no paper.version" in report.checks["chain"].message
    assert report.genesis == paper.paper_id


def test_garbage_records_never_raise():
    paper = make_paper(versions=2)
    garbage = [
        {},
        {"type": "paper.version"},
        {"type": "paper.version", "body": "text", "id": "x"},
        {"type": "paper.genesis", "id": 7, "body": []},
        {"type": "coauthor.consent", "body": {"version": paper.versions[0]["id"]}},
        {"type": "retraction", "body": {"target": paper.paper_id}, "author": 3},
        {"type": "manifest", "id": paper.manifests[0]["id"], "body": None},
        {"type": None, "body": {"target": paper.paper_id}},
    ]
    report = verify_paper(paper.records() + garbage)
    assert isinstance(report, VerificationReport)
    assert report.status == STATUS_INVALID  # the unauthentic consent / retraction claims


@pytest.mark.parametrize(
    "mutation",
    ["type", "author", "created", "prev", "body", "proofs", "v", "id", "sig"],
)
def test_any_single_field_change_to_a_chain_record_is_detected(mutation):
    paper = make_paper(versions=2)
    target = paper.versions[0]
    forged = copy.deepcopy(target)
    forged[mutation] = {
        "type": "paper.genesis",
        "author": did("mallory"),
        "created": "2030-01-01T00:00:00Z",
        "prev": paper.versions[1]["id"],
        "body": {**target["body"], "title": "x"},
        "proofs": ["x"],
        "v": 2,
        "id": paper.versions[1]["id"],
        "sig": paper.versions[1]["sig"],
    }[mutation]
    report = verify_paper(swap(paper.records(), target, forged))
    assert report.status == STATUS_INVALID


def test_byte_flip_in_any_signed_record_is_detected():
    paper = make_paper(versions=2)
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    records = paper.records()
    for index, record in enumerate(records):
        flipped = copy.deepcopy(record)
        flipped["body"]["__flip__"] = 1
        altered = records[:index] + [flipped] + records[index + 1 :]
        assert verify_paper(altered).status == STATUS_INVALID, record["type"]


# --- arguments ----------------------------------------------------------


def test_non_mapping_records_raise_value_error():
    with pytest.raises(ValueError, match=r"records\[1\] must be a mapping"):
        verify_paper([make_paper().genesis, "not a record"])
    with pytest.raises(ValueError, match="must be a mapping"):
        verify_paper(["abc"])


@pytest.mark.parametrize("bad", ["", "nonsense", "sch:abcd-efgh-ijkl", "sch:aaaa-aaaa", 7])
def test_malformed_paper_argument_raises(bad):
    with pytest.raises(ValueError):
        verify_paper([], paper=bad)


@pytest.mark.parametrize("bad", ["", "nonsense", "sch:aaaa-aaaa-aaaa/v0", 7])
def test_malformed_head_argument_raises(bad):
    with pytest.raises(ValueError):
        verify_paper([], head=bad)


def test_bad_checksum_in_a_sch_argument_raises_with_the_reason():
    paper = make_paper()
    mistyped = paper.short_id[:-1] + ("a" if paper.short_id[-1] != "a" else "b")
    with pytest.raises(ValueError, match="checksum"):
        verify_paper(paper.records(), paper=mistyped)


def test_head_must_be_a_version_id_not_a_bare_paper_id():
    paper = make_paper()
    with pytest.raises(ValueError, match="version"):
        verify_paper(paper.records(), head=paper.short_id)


def test_paper_and_head_naming_different_papers_raise():
    first = make_paper(seed="first")
    second = make_paper(seed="second")
    with pytest.raises(ValueError, match="different papers"):
        verify_paper(
            first.records() + second.records(),
            paper=first.short_id,
            head=format_version_id(second.short_id, 1),
        )
    with pytest.raises(ValueError, match="different papers"):
        verify_paper(
            first.records() + second.records(),
            paper=first.paper_id,
            head=format_version_id(second.short_id, 1),
        )


@pytest.mark.parametrize("bad", [did("alice"), b"x", 5, [5], None])
def test_authorities_must_be_a_collection_of_strings(bad):
    with pytest.raises(ValueError):
        verify_paper([], authorities=bad)


def test_arguments_are_keyword_only():
    with pytest.raises(TypeError):
        verify_paper([], "sch:aaaa-aaaa-aaaa")  # type: ignore[misc]


def test_verify_does_not_mutate_its_input():
    paper = make_paper(versions=2)
    paper.extra.append(notice("alice", "correction", paper.paper_id))
    records = paper.records()
    before = copy.deepcopy(records)
    verify_paper(records, authorities=[did("committee")])
    assert records == before
