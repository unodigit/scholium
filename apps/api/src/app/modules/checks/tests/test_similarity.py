"""Tests for the similarity check (feature 66).

The check saves ``similarity_pct`` to ``check_results``: the highest word
5-gram shingle Jaccard similarity, as a percentage, between a version's saved
text and every listed paper.

Covers the metric itself (5-gram shingles, set semantics, case/punctuation/
whitespace/Unicode folding, short texts), the corpus (every other saved
version by default, explicit papers in all accepted forms, the target always
excluded), the persisted row and its upsert semantics (one row per version,
other checks' columns untouched), validation, and concurrency.

Isolation note: xdist workers get their own database file but tests in a
worker share the tables, so each test uses a fresh random version cid and
texts built from unique random words.  Unrelated rows can then never share a
shingle with the texts under test.
"""

from __future__ import annotations

import threading
import uuid

import pytest
from scholium_record_core import compute_record_id
from sqlalchemy import text

from app import db
from app.modules import checks

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"


def new_version_cid() -> str:
    """A real, unique dag-cbor record id, as a version's cid is."""
    return compute_record_id(
        {
            "v": 1,
            "type": "test.checks",
            "author": AUTHOR,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def stored_row(version_cid: str) -> tuple | None:
    """The raw check_results row of a version, or None."""
    with db.SessionLocal() as session:
        row = session.execute(
            text(
                "SELECT version_cid, similarity_pct, references_total, "
                "references_unresolved, metadata_match FROM check_results "
                "WHERE version_cid = :v"
            ),
            {"v": version_cid},
        ).one_or_none()
    if row is None:
        return None
    version, similarity, total, unresolved, matched = row
    return (version, similarity, total, unresolved, None if matched is None else bool(matched))


def words(count: int) -> list[str]:
    """``count`` distinct random words -- no other test can share a shingle."""
    return [f"w{uuid.uuid4().hex}" for _ in range(count)]


def shingles_of(items: list[str], n: int = 5) -> set[tuple[str, ...]]:
    """An independent word ``n``-gram shingle set, for expected values."""
    return {tuple(items[start : start + n]) for start in range(len(items) - n + 1)}


def pct_of(first: list[str], second: list[str], n: int = 5) -> float:
    """An independent expected Jaccard percentage."""
    left, right = shingles_of(first, n), shingles_of(second, n)
    return len(left & right) / len(left | right) * 100.0 if left | right else 0.0


def save_text(version_cid: str, items: list[str]) -> list[checks.Paragraph]:
    checks.save_paragraphs(version_cid, [" ".join(items)])
    return checks.get_version_text(version_cid)


# --- the metric ----------------------------------------------------------------------


def test_identical_texts_are_one_hundred_percent_similar():
    document = " ".join(words(12))

    assert checks.similarity_pct(document, document) == 100.0


def test_texts_with_no_shared_shingle_are_zero_percent_similar():
    assert checks.similarity_pct(" ".join(words(10)), " ".join(words(10))) == 0.0


def test_the_percentage_is_the_jaccard_index_of_word_five_grams():
    # A = 1 2 3 4 5 6, B = 1 2 3 4 5 7: shingles {12345, 23456} and
    # {12345, 23457}; one in common out of three.
    first = "alpha bravo charlie delta echo foxtrot"
    second = "alpha bravo charlie delta echo golf"

    assert checks.word_shingles(first) == {
        ("alpha", "bravo", "charlie", "delta", "echo"),
        ("bravo", "charlie", "delta", "echo", "foxtrot"),
    }
    assert checks.jaccard_similarity(first, second) == pytest.approx(1 / 3)
    assert checks.similarity_pct(first, second) == pytest.approx(100 / 3)


def test_shingles_are_five_words_long_by_default():
    document = "one two three four five six seven"

    assert checks.DEFAULT_SHINGLE_SIZE == 5
    assert checks.word_shingles(document) == {
        ("one", "two", "three", "four", "five"),
        ("two", "three", "four", "five", "six"),
        ("three", "four", "five", "six", "seven"),
    }
    assert len(checks.word_shingles(document, 3)) == 5
    assert len(checks.word_shingles(document, 7)) == 1


def test_a_text_shorter_than_the_shingle_has_no_shingles_and_scores_zero():
    assert checks.word_shingles("one two three four") == frozenset()
    assert checks.similarity_pct("one two three four", "one two three four") == 0.0


def test_repeated_shingles_count_once():
    # Eleven words make seven overlapping 5-grams, but the first and last are
    # the same words, so the set holds six.
    document = "alpha bravo charlie delta echo xray alpha bravo charlie delta echo"

    assert len(checks.word_shingles(document)) == 6
    # Jaccard works on the sets, so a repeated shingle is not counted twice.
    assert checks.jaccard_index(["a", "a", "b"], ["a", "b", "b"]) == 1.0


def test_case_punctuation_and_whitespace_do_not_change_the_score():
    first = "Alpha, BETA! charlie; delta\techo."
    second = "alpha beta\ncharlie   delta echo"

    assert checks.similarity_pct(first, second) == 100.0


def test_unicode_is_nfkc_folded_and_case_folded():
    first = "The ﬁndings of １２ studies about widgets"
    second = "the findings of 12 studies about widgets"

    assert checks.similarity_pct(first, second) == 100.0


def test_changing_one_word_of_five_breaks_that_shingle():
    first = "alpha bravo charlie delta echo"
    second = "alpha bravo charlie delta zulu"

    assert checks.similarity_pct(first, second) == 0.0


def test_jaccard_index_is_the_ratio_of_the_intersection_to_the_union():
    assert checks.jaccard_index({1, 2, 3}, {2, 3, 4}) == pytest.approx(2 / 4)
    assert checks.jaccard_index({"a"}, {"a"}) == 1.0
    assert checks.jaccard_index({"a"}, {"b"}) == 0.0


def test_jaccard_index_of_two_empty_sets_is_zero_not_one():
    assert checks.jaccard_index(set(), set()) == 0.0


def test_the_shingle_size_must_be_a_positive_integer():
    for bad in (0, -1):
        with pytest.raises(ValueError):
            checks.word_shingles("a b c d e", bad)
        with pytest.raises(ValueError):
            checks.similarity_pct("a b c d e", "a b c d e", bad)
    for bad in (5.0, "5", None, True):
        with pytest.raises(TypeError):
            checks.word_shingles("a b c d e", bad)  # type: ignore[arg-type]


def test_a_non_string_text_is_a_type_error():
    for bad in (None, 5, b"bytes", ["a", "b"]):
        with pytest.raises(TypeError):
            checks.word_shingles(bad)  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            checks.similarity_pct(bad, "a b c d e")  # type: ignore[arg-type]


# --- the default corpus: every other saved version -----------------------------------


def test_similarity_is_saved_against_another_saved_version():
    shared = words(15)
    target_words = shared + words(5)
    target, other = new_version_cid(), new_version_cid()
    save_text(target, target_words)
    save_text(other, shared)

    result = checks.save_similarity_check(target)

    expected = pct_of(target_words, shared)
    assert result.similarity_pct == pytest.approx(expected)
    assert result.closest_cid == other
    assert stored_row(target)[1] == pytest.approx(expected)


def test_the_saved_value_is_the_maximum_over_every_comparison():
    target_words = words(12)
    close_words = target_words[:10] + words(2)
    far_words = target_words[:4] + words(20)
    target = new_version_cid()
    save_text(target, target_words)

    result = checks.save_similarity_check(
        target,
        [("close", " ".join(close_words)), ("far", " ".join(far_words))],
    )

    expected = max(pct_of(target_words, close_words), pct_of(target_words, far_words))
    assert result.closest_cid == "close"
    assert result.compared == 2
    assert result.similarity_pct == pytest.approx(expected)
    assert stored_row(target)[1] == pytest.approx(expected)


def test_a_version_is_never_compared_with_itself():
    target = new_version_cid()
    save_text(target, words(20))

    result = checks.save_similarity_check(target)

    # Its own text would score 100; another test's random words score 0.
    assert result.similarity_pct == 0.0
    assert stored_row(target)[1] == 0.0


def test_an_empty_explicit_corpus_saves_zero():
    target = new_version_cid()
    save_text(target, words(10))

    result = checks.save_similarity_check(target, papers=[])

    assert result == checks.SimilarityCheck(similarity_pct=0.0, closest_cid=None, compared=0)
    assert stored_row(target)[1] == 0.0


def test_a_version_without_saved_text_saves_zero():
    target = new_version_cid()
    other = new_version_cid()
    save_text(other, words(10))

    result = checks.save_similarity_check(target, [other])

    assert result.similarity_pct == 0.0
    assert stored_row(target)[1] == 0.0


def test_another_versions_cid_uses_its_saved_text():
    shared = words(15)
    target_words = shared + words(3)
    target, other = new_version_cid(), new_version_cid()
    save_text(target, target_words)
    save_text(other, shared)

    result = checks.save_similarity_check(target, [other])

    assert result.closest_cid == other
    assert result.similarity_pct == pytest.approx(pct_of(target_words, shared))


# --- explicit paper forms -------------------------------------------------------------


def test_raw_text_paragraphs_pairs_and_mappings_are_accepted():
    target_words = words(12)
    target = new_version_cid()
    save_text(target, target_words)
    as_text = " ".join(target_words)
    paragraphs = [
        checks.Paragraph(position=0, paragraph_id="a", text=target_words[0]),
        checks.Paragraph(position=1, paragraph_id="b", text=" ".join(target_words[1:])),
    ]

    for papers in (
        [as_text],
        [checks.PaperText(cid=None, text=as_text)],
        [("same", as_text)],
        [{"cid": "same", "text": as_text}],
        [{"version_cid": "same", "paragraphs": target_words}],
        [paragraphs],  # one paper, split into paragraphs
        [target_words],
        {"same": as_text},
        {"version_cid": "same", "text": as_text},
    ):
        result = checks.save_similarity_check(target, papers)
        assert result.similarity_pct == pytest.approx(100.0), papers
        assert result.compared == 1, papers


def test_objects_with_a_text_attribute_are_accepted():
    target_words = words(8)
    target = new_version_cid()
    save_text(target, target_words)

    class Body:
        text = " ".join(target_words)

    result = checks.save_similarity_check(target, [Body()])

    assert result.similarity_pct == pytest.approx(100.0)


def test_a_mapping_without_a_text_key_is_a_type_error():
    target = new_version_cid()
    save_text(target, words(8))

    with pytest.raises(TypeError):
        checks.save_similarity_check(target, [{"cid": "x"}])


def test_papers_and_texts_cannot_both_be_given():
    target = new_version_cid()
    save_text(target, words(8))

    with pytest.raises(TypeError):
        checks.save_similarity_check(target, ["a"], texts=["b"])


def test_texts_is_an_alias_for_papers():
    target_words = words(8)
    target = new_version_cid()
    save_text(target, target_words)

    result = checks.save_similarity_check(target, texts=[" ".join(target_words)])

    assert result.similarity_pct == pytest.approx(100.0)


def test_an_unusable_paper_item_is_a_type_error_and_saves_nothing():
    target = new_version_cid()
    save_text(target, words(8))

    with pytest.raises(TypeError):
        checks.save_similarity_check(target, [5])
    with pytest.raises(TypeError):
        checks.save_similarity_check(target, [b"bytes"])

    assert stored_row(target) is None


# --- validation ----------------------------------------------------------------------


def test_an_invalid_version_cid_is_rejected_and_saves_nothing():
    canonical = new_version_cid()

    for bad in ("", "abc", "not a cid", canonical.upper(), canonical[:-3], None, 12):
        with pytest.raises(checks.InvalidVersionCid):
            checks.save_similarity_check(bad)  # type: ignore[arg-type]

    assert stored_row(canonical) is None


# --- the persisted row ---------------------------------------------------------------


def test_writing_twice_replaces_the_value_and_leaves_other_columns_alone():
    first_words, second_words = words(15), words(15)
    target = new_version_cid()
    save_text(target, first_words)
    checks.save_check_result(target, references_total=7, references_unresolved=3, metadata_match=True)

    checks.save_similarity_check(target, [("first", " ".join(first_words))])
    checks.save_similarity_check(target, [("second", " ".join(second_words))])

    row = stored_row(target)
    assert row == (target, 0.0, 7, 3, True)


def test_similarity_does_not_clear_other_check_columns_saved_later():
    target = new_version_cid()
    save_text(target, words(10))
    checks.save_similarity_check(target, [("same", " ".join(words(10)))])

    checks.save_check_result(target, metadata_match=False)

    row = stored_row(target)
    assert row[1] == 0.0
    assert row[4] is False


def test_get_check_result_exposes_the_saved_percentage():
    target_words = words(10)
    target = new_version_cid()
    save_text(target, target_words)

    checks.save_similarity_check(target, [("same", " ".join(target_words))])

    row = checks.get_check_result(target)
    assert row is not None
    assert row.similarity_pct == pytest.approx(100.0)


def test_the_returned_check_reports_what_was_saved():
    target_words = words(10)
    target = new_version_cid()
    save_text(target, target_words)

    result = checks.save_similarity_check(target, [("same", " ".join(target_words))])

    assert isinstance(result, checks.SimilarityCheck)
    assert result.pct == result.similarity_pct == pytest.approx(100.0)
    assert result.closest_cid == "same"
    assert result.compared == 1


# --- concurrency ----------------------------------------------------------------------


def test_concurrent_writes_leave_one_row():
    target_words = words(10)
    target = new_version_cid()
    save_text(target, target_words)
    errors: list[BaseException] = []

    def save() -> None:
        try:
            checks.save_similarity_check(target, [("same", " ".join(target_words))])
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    checks.ensure_check_results_table()
    threads = [threading.Thread(target=save) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert stored_row(target) == (target, pytest.approx(100.0), None, None, None)
