"""Tests for the cross-language verification vectors (vectors/verification.json)."""

import copy
import json
import random
from pathlib import Path

import pytest
from nacl.signing import SigningKey

from scholium_record_core import (
    CHECK_NAMES,
    STATUS_INVALID,
    STATUSES,
    did_key_from_signing_key,
    verify_paper,
)
from scholium_record_core.vectors import (
    build_verification_records,
    dumps_vectors,
    load_vectors,
    refresh_verification_vectors,
)

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "verification.json"


@pytest.fixture(scope="module")
def doc():
    return load_vectors(VECTORS_PATH)


@pytest.fixture(scope="module")
def dids(doc):
    return {key["name"]: key["did_key"] for key in doc["keys"]}


def vector(doc, name):
    return next(v for v in doc["vectors"] if v["name"] == name)


def test_vector_file_exists_and_parses():
    assert VECTORS_PATH.is_file()
    parsed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert parsed["version"] == 1
    assert len(parsed["keys"]) >= 4
    assert len(parsed["vectors"]) >= 20


def test_header_pins_the_verification_rules(doc):
    header = doc["verification"]
    assert header["statuses"] == list(STATUSES)
    assert header["checks"] == list(CHECK_NAMES)
    assert header["status_precedence"] == [
        "invalid",
        "retracted",
        "tombstoned",
        "corrected",
        "verified",
    ]
    assert header["consent_decisions"] == ["accept", "decline"]
    assert header["authorized_signers"]["tombstone"] == "a trusted authority"


def test_names_are_unique(doc):
    for items in (doc["keys"], doc["vectors"]):
        names = [item["name"] for item in items]
        assert len(names) == len(set(names))


def test_every_key_derives_its_did_from_its_seed_alone(doc):
    for key in doc["keys"]:
        seed = bytes.fromhex(key["seed_hex"])
        assert len(seed) == 32
        assert key["did_key"] == did_key_from_signing_key(SigningKey(seed))


def test_every_vector_reproduces_its_records_from_its_build_steps(doc):
    for vec in doc["vectors"]:
        records, ids = build_verification_records(doc["keys"], vec["build"])
        assert records == vec["records"], vec["name"]
        assert ids == vec["ids"], vec["name"]


def test_every_vector_matches_the_expected_report(doc, dids):
    for vec in doc["vectors"]:
        report = verify_paper(vec["records"], **vec["call"])
        expect = vec["expect"]
        ids = vec["ids"]
        name = vec["name"]
        assert report.status == expect["status"], name
        assert report.version_count == expect["version_count"], name
        assert list(report.signers) == [dids[k] for k in expect["signers"]], name
        assert report.genesis == (
            ids[expect["genesis"]] if expect["genesis"] else None
        ), name
        assert report.head == (ids[expect["head"]] if expect["head"] else None), name
        assert {n: c.passed for n, c in report.checks.items()} == expect[
            "checks"
        ], name
        assert [
            {"kind": s.kind, "applied": s.applied} for s in report.supersessions
        ] == expect["supersessions"], name
        assert report.valid == (expect["status"] != STATUS_INVALID), name


def test_verdicts_do_not_depend_on_record_order(doc):
    for vec in doc["vectors"]:
        expected = verify_paper(vec["records"], **vec["call"])
        shuffled = list(vec["records"])
        for seed in range(3):
            random.Random(seed).shuffle(shuffled)
            assert verify_paper(shuffled, **vec["call"]) == expected, vec["name"]


def test_vectors_cover_every_status_and_every_failing_check(doc):
    statuses = {v["expect"]["status"] for v in doc["vectors"]}
    assert statuses == set(STATUSES)
    for check in CHECK_NAMES:
        assert any(
            v["expect"]["checks"][check] is False for v in doc["vectors"]
        ), check
        assert any(
            v["expect"]["checks"][check] is True for v in doc["vectors"]
        ), check


def test_every_expectation_names_every_check(doc):
    for vec in doc["vectors"]:
        assert list(vec["expect"]["checks"]) == list(CHECK_NAMES), vec["name"]


def test_only_invalid_vectors_fail_checks(doc):
    for vec in doc["vectors"]:
        failing = [c for c, ok in vec["expect"]["checks"].items() if not ok]
        assert bool(failing) == (vec["expect"]["status"] == "invalid"), vec["name"]


def test_vectors_contain_no_floats(doc):
    def walk(value):
        if isinstance(value, float):
            raise AssertionError("vector data must not contain floats")
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(doc)


def test_the_tampered_head_vector_really_changed_after_signing(doc):
    vec = vector(doc, "invalid-tampered-head-body")
    head = next(r for r in vec["records"] if r["id"] == vec["ids"]["v1"])
    assert head["body"]["title"] == "Forged title"


def test_omitted_records_are_absent_but_their_ids_are_listed(doc):
    vec = vector(doc, "invalid-missing-genesis")
    present = {r["id"] for r in vec["records"]}
    assert vec["ids"]["genesis"] not in present
    assert vec["ids"]["v1"] in present


def test_call_arguments_are_resolved_to_ids_and_dids(doc, dids):
    by_sch = vector(doc, "verified-earlier-version-by-sch-id")
    assert by_sch["call"]["head"].startswith("sch:")
    assert by_sch["call"]["head"].endswith("/v2")
    trusted = vector(doc, "tombstoned-by-trusted-authority")
    assert trusted["call"]["authorities"] == [dids["committee"]]
    named = vector(doc, "verified-fork-resolved-by-naming-the-head")
    assert named["call"]["head"] == named["ids"]["v2a"]


def test_committed_file_matches_the_implementation(doc):
    """The file must be exactly what refresh produces -- no drift."""
    text = VECTORS_PATH.read_text(encoding="utf-8")
    refreshed = refresh_verification_vectors(copy.deepcopy(doc))
    assert dumps_vectors(refreshed) == text
    assert dumps_vectors(refresh_verification_vectors(refreshed)) == text
