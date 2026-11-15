"""Acceptance tests for: API exposes GET /v1/search?q= that returns ranked results
with facet counts and filters for category, date range, status and has_code
(search plugin, feature 86).

Criteria (app_spec.xml, feature 86):

* GET /v1/search?q=<word from a listed title> returns that paper in the first
  5 results.
* GET /v1/search?q=x&status=reviewed returns only reviewed papers with facets
  in the body.

The first two tests below are those criteria, one each.  The rest cover the
feature line -- facet counts, the ``category`` and ``has_code`` filters, and
ranking -- and assert nothing beyond it.

What is *not* tested, on purpose
--------------------------------

The feature line names a "date range" filter but neither the criteria nor the
spec fix its query parameters (``from``/``to``? ``since``/``until``?), so a test
for it could only guess a name and would fail a correct implementation that
chose another.  ``category``, ``status`` and ``has_code`` are named by the
feature line and are the parameters used here.

How the scene is set up
-----------------------

The papers belong to the submissions plugin, whose ``POST /v1/records`` handlers
are guarded by tier, endorsement, consent and moderation rules that have nothing
to do with searching.  So the scene is put in place the way the sibling suites
do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record, each
  correctly signed and appended to the event log, the manifest's files stored in
  the content store;
* the paper and its version indexed through the submissions plugin's own exported
  ``save_paper`` / ``save_version`` -- the calls its handlers make.  ``save_paper``
  takes the paper's ``status``, which is how a paper is made ``reviewed`` without
  depending on the status plugin's ledger subscription (a later feature);
* the version is *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``), which is what a moderator's
  decision ends up calling.  Listing is what puts a version into ``search_fts``
  (feature 85), so nothing here writes to the index directly.

Everything the criteria are about goes through the public surface: an anonymous
``GET /v1/search``.

"Has code" means the version's signed manifest lists a file whose ``role`` is
``code`` (the ``scholium_record_core`` file-role vocabulary); a manifest with
only a manuscript has none.

Reading the response
--------------------

The criteria fix *which papers* come back, in *which order*, and that facets are
in the body; they do not fix the JSON layout.  The helpers below therefore find
the result list under any of the usual keys (``results``, ``items``, ``hits``,
...), recognise a result as a scene paper by any of its ids (``sch:`` id, paper
cid, version cid) or its title wherever the result carries them, and read facet
counts from a mapping (``{"cs.CR": 3}``) or a list of buckets
(``[{"value": "cs.CR", "count": 3}]``).  Every paper in a scene has a unique title
word, so a paper is identified by what the response says and never by the shape
around it.

Why every query uses a unique word
----------------------------------

All tests share one database, so each builds papers around words no other test
uses and asserts on its own papers, never on totals.  The one exception is the
literal query ``x`` of the second criterion: the papers of that test carry the
word ``x`` and no other test does.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

from nacl.signing import SigningKey
from scholium_record_core import (
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import content, ledger
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

SEARCH_URL = "/v1/search"

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")


# --------------------------------------------------------------------------- #
# The scene: listed papers with a status, categories and (maybe) code
# --------------------------------------------------------------------------- #


def _word() -> str:
    """A token no other test's text contains (letters first: a plain FTS5 bareword)."""
    return "zq" + uuid.uuid4().hex


class ScenePaper:
    """One paper with a single version, listed on construction when asked.

    ``title`` and ``abstract`` are the version's signed metadata -- the text the
    search index holds -- and ``status`` is the paper's ``papers.status``.  The
    paper has a code archive in its manifest only when ``has_code`` is true.
    """

    def __init__(
        self,
        title: str,
        *,
        abstract: Optional[str] = None,
        categories: tuple[str, ...] = ("cs.CR",),
        status: str = "preprint",
        has_code: bool = False,
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.title = title
        self.abstract = abstract if abstract is not None else f"What paper {self.tag} is about."
        self.categories = list(categories)
        self.status = status
        self.has_code = has_code
        self._key = SigningKey.generate()
        self.author_did = did_key_from_signing_key(self._key)

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance genesis {self.tag}",
                "abstract": "A paper readers search for.",
                "categories": self.categories,
                "licence": "CC-BY-4.0",
                "authors": [self.author_did],
            },
        )
        ledger.append(genesis)
        self.paper_cid = genesis["id"]
        save_paper(
            paper_cid=self.paper_cid,
            categories=tuple(self.categories),
            licence="CC-BY-4.0",
            status=self.status,
        )
        #: The ``sch:xxxx-xxxx-xxxx`` id of the paper.
        self.short_id = derive_short_id(self.paper_cid)
        self.version_cid = self._add_version(genesis_cid=self.paper_cid)

    # -- signing --------------------------------------------------------- #

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete record signed by the author: ``id`` is the recomputed cid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.author_did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self._key,
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    # -- the version ----------------------------------------------------- #

    def _store_file(self, name: str, media_type: str, role: str) -> dict:
        """Put a file's bytes in the content store; return its manifest entry."""
        data = f"acceptance {name} of paper {self.tag}".encode()
        blob = content.store_bytes(data, media_type=media_type)
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        return {
            "path": name,
            "cid": blob.cid,
            "size": len(data),
            "mediaType": media_type,
            "role": role,
        }

    def _add_version(self, *, genesis_cid: str) -> str:
        """Store version 1 (in ``awaiting_consent``); return its cid."""
        files = [self._store_file("main.pdf", "application/pdf", "manuscript")]
        if self.has_code:
            files.append(self._store_file("code.tar.gz", "application/gzip", "code"))
        manifest = self._sign("manifest", {"files": files})
        record = self._sign(
            "paper.version",
            {
                "paper": genesis_cid,
                "n": 1,
                "title": self.title,
                "abstract": self.abstract,
                "authors": [
                    {"did": self.author_did, "position": 1, "creditRoles": ["Conceptualization"]}
                ],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "Version 1.",
            },
            prev=genesis_cid,
        )
        ledger.append(manifest)
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=genesis_cid,
            n=1,
            title=self.title,
            abstract=self.abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis_cid,
            change_note="Version 1.",
            authors=(VersionAuthor(self.author_did, 1, ("Conceptualization",)),),
        )
        return record["id"]

    def listed(self) -> "ScenePaper":
        """Take the version through scanning and moderation to ``listed``."""
        for state in _TO_LISTED:
            transition_version(self.version_cid, state)
        return self

    # -- how a response can name the paper ------------------------------- #

    @property
    def handles(self) -> set[str]:
        """Every string a search result may use to say "this paper"."""
        return {
            self.short_id,
            f"{self.short_id}/v1",
            self.paper_cid,
            self.version_cid,
            self.title,
        }


def _listed(title: str, **kwargs: Any) -> ScenePaper:
    return ScenePaper(title, **kwargs).listed()


# --------------------------------------------------------------------------- #
# Reading a response
# --------------------------------------------------------------------------- #

_RESULT_KEYS = ("results", "items", "hits", "papers", "data")


def _search(client, q: str, **filters: str):
    """``GET /v1/search?q=...`` as an anonymous reader."""
    return client.get(SEARCH_URL, params={"q": q, **filters})


def _ok(client, q: str, **filters: str) -> dict:
    """``GET /v1/search`` -- must answer 200 with a JSON object; return it."""
    response = _search(client, q, **filters)
    assert response.status_code == 200, (
        f"GET {SEARCH_URL} q={q!r} {filters} -> {response.status_code}: {response.text}"
    )
    body = response.json()
    assert isinstance(body, dict), f"the body must be an object (it carries facets): {body!r}"
    return body


def _find_results(node: Any, depth: int = 0) -> Optional[list]:
    if isinstance(node, list):
        return node
    if not isinstance(node, dict) or depth > 1:
        return None
    for key in _RESULT_KEYS:
        found = _find_results(node.get(key), depth + 1)
        if found is not None:
            return found
    for key, value in node.items():
        if key != "facets" and isinstance(value, list):
            return value
    return None


def _results(body: dict) -> list:
    """The ranked result list of a response, best first."""
    found = _find_results(body)
    assert found is not None, f"the body has no result list: {body}"
    return found


def _strings(value: Any, depth: int = 0) -> Iterator[str]:
    """Every string in a result: its own, or those nested in objects and lists."""
    if isinstance(value, str):
        yield value
    elif depth < 4 and isinstance(value, dict):
        for item in value.values():
            yield from _strings(item, depth + 1)
    elif depth < 4 and isinstance(value, list):
        for item in value:
            yield from _strings(item, depth + 1)


def _refers_to(result: Any, paper: ScenePaper) -> bool:
    return not paper.handles.isdisjoint(_strings(result))


def _positions(results: list, paper: ScenePaper) -> list[int]:
    return [i for i, result in enumerate(results) if _refers_to(result, paper)]


def _has(results: list, paper: ScenePaper) -> bool:
    return bool(_positions(results, paper))


def _reported_status(result: Any) -> Optional[str]:
    """The ``status`` a result states for itself (top level or one object down)."""
    if not isinstance(result, dict):
        return None
    for scope in [result] + [v for v in result.values() if isinstance(v, dict)]:
        value = scope.get("status")
        if isinstance(value, str):
            return value.strip().lower().replace(" ", "_").replace("-", "_")
    return None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


_COUNT_KEYS = ("count", "n", "doc_count", "total", "num")
_LABEL_KEYS = ("value", "key", "name", "label", "term", "id")
_BUCKET_KEYS = ("buckets", "values", "counts", "items", "options", "terms")


def _counts(group: Any) -> dict[str, int]:
    """One facet's ``{value: count}`` from a mapping or a list of buckets."""
    counts: dict[str, int] = {}
    if isinstance(group, dict):
        for key in _BUCKET_KEYS:
            if isinstance(group.get(key), (list, dict)):
                return _counts(group[key])
        for label, value in group.items():
            if _is_int(value):
                counts[str(label)] = value
            elif isinstance(value, dict):
                count = next((value[k] for k in _COUNT_KEYS if _is_int(value.get(k))), None)
                if count is not None:
                    counts[str(label)] = count
    elif isinstance(group, list):
        for item in group:
            if isinstance(item, dict):
                count = next((item[k] for k in _COUNT_KEYS if _is_int(item.get(k))), None)
                label = next((item[k] for k in _LABEL_KEYS if isinstance(item.get(k), str)), None)
                if label is None:  # {"category": "cs.CR", "count": 3}
                    label = next((v for v in item.values() if isinstance(v, str)), None)
                if label is not None and count is not None:
                    counts[label] = count
            elif isinstance(item, (list, tuple)) and len(item) == 2 and _is_int(item[1]):
                counts[str(item[0])] = item[1]
    return counts


def _facet(body: dict, *names: str) -> dict[str, int]:
    """The counts of the facet called any of ``names``, keys lower-cased."""
    facets = body.get("facets")
    assert isinstance(facets, (dict, list)) and facets, f"the body has no facets: {body}"
    group = None
    if isinstance(facets, dict):
        group = next((facets[name] for name in names if name in facets), None)
    else:
        for entry in facets:
            if isinstance(entry, dict) and any(
                entry.get(k) in names for k in ("name", "field", "facet", "key")
            ):
                group = entry
                break
    assert group is not None, f"no {names[0]!r} facet in {facets}"
    counts = _counts(group)
    assert counts, f"could not read counts from the {names[0]!r} facet: {group}"
    return {str(label).strip().lower().replace(" ", "_"): n for label, n in counts.items()}


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_word_from_a_listed_title_returns_that_paper_in_the_first_five_results(client):
    """GET /v1/search?q=<word from a listed title> returns that paper in the first 5 results."""
    first, middle, last = _word(), _word(), _word()
    target = _listed(f"Notes on {first} and {middle} in {last}")
    # Papers listed *after* the target that share none of its words.  A search
    # that ignored ``q`` and returned the newest papers would bury the target
    # well below the fifth place.
    for _ in range(10):
        _listed(f"Unrelated acceptance paper {uuid.uuid4().hex}")

    for word in (first, middle, last):
        results = _results(_ok(client, word))
        assert any(_refers_to(result, target) for result in results[:5]), (
            f"searching {word!r}, a word of the title {target.title!r}, did not return "
            f"{target.short_id} in the first 5 results: {results}"
        )


def test_status_reviewed_returns_only_reviewed_papers_with_facets_in_the_body(client):
    """GET /v1/search?q=x&status=reviewed returns only reviewed papers with facets in the body."""
    # Every paper carries the word "x", so the query matches all of them and
    # only the status filter can tell them apart.
    reviewed = [
        _listed(f"Acceptance x study {uuid.uuid4().hex}", status="reviewed") for _ in range(2)
    ]
    others = [
        _listed(f"Acceptance x study {uuid.uuid4().hex}", status=status)
        for status in ("preprint", "under_review", "contested", "corrected")
    ]
    scene = reviewed + others

    # Without the filter the query finds the whole scene -- the filter, not a
    # failed match, is what leaves the others out below.
    unfiltered = _results(_ok(client, "x"))
    assert all(_has(unfiltered, paper) for paper in scene), unfiltered

    body = _ok(client, "x", status="reviewed")
    results = _results(body)

    assert all(_has(results, paper) for paper in reviewed), (
        f"the reviewed papers are missing from {results}"
    )
    for paper in others:
        assert not _has(results, paper), (
            f"a {paper.status} paper ({paper.short_id}) was returned by status=reviewed"
        )
    # Nothing else comes back either: every result is a reviewed paper, whether
    # the result says so itself or is one of the scene's reviewed papers.
    for result in results:
        reported = _reported_status(result)
        owner = next((paper for paper in scene if _refers_to(result, paper)), None)
        assert reported is not None or owner is not None, (
            f"cannot tell which paper this result is, or its status: {result}"
        )
        if reported is not None:
            assert reported == "reviewed", f"result is {reported}, not reviewed: {result}"
        if owner is not None:
            assert owner.status == "reviewed", f"{owner.status} paper returned: {result}"

    facets = body.get("facets")
    assert isinstance(facets, (dict, list)) and facets, f"the body has no facets: {body}"


# --------------------------------------------------------------------------- #
# The rest of the feature line
# --------------------------------------------------------------------------- #


def test_facets_count_the_matching_papers_by_category_and_status(client):
    """Facet counts: how many matching papers there are per category and per status."""
    word = _word()
    _listed(f"{word} reviewed security", categories=("cs.CR",), status="reviewed")
    _listed(f"{word} preprint security", categories=("cs.CR",), status="preprint")
    _listed(f"{word} preprint learning", categories=("cs.LG",), status="preprint")
    _listed(f"{word} preprint more security", categories=("cs.CR",), status="preprint")

    body = _ok(client, word)

    assert len(_results(body)) == 4, body
    categories = _facet(body, "category", "categories")
    assert categories.get("cs.cr") == 3, categories
    assert categories.get("cs.lg") == 1, categories
    statuses = _facet(body, "status", "statuses")
    assert statuses.get("reviewed") == 1, statuses
    assert statuses.get("preprint") == 3, statuses


def test_category_filter_returns_only_papers_in_that_category(client):
    """The category filter keeps papers in that category and drops the others."""
    word = _word()
    security = _listed(f"{word} security", categories=("cs.CR",))
    learning = _listed(f"{word} learning", categories=("cs.LG",))
    both = _listed(f"{word} both", categories=("cs.CR", "cs.LG"))

    # Sanity: the word finds all three, so the filter is what narrows them.
    everything = _results(_ok(client, word))
    assert all(_has(everything, paper) for paper in (security, learning, both)), everything

    in_security = _results(_ok(client, word, category="cs.CR"))
    assert _has(in_security, security), in_security
    assert _has(in_security, both), in_security
    assert not _has(in_security, learning), in_security

    in_learning = _results(_ok(client, word, category="cs.LG"))
    assert _has(in_learning, learning), in_learning
    assert not _has(in_learning, security), in_learning


def test_has_code_filter_returns_only_papers_with_code(client):
    """The has_code filter keeps papers whose manifest lists code and drops the others."""
    word = _word()
    with_code = _listed(f"{word} with a code archive", has_code=True)
    without_code = _listed(f"{word} with a manuscript only", has_code=False)

    everything = _results(_ok(client, word))
    assert _has(everything, with_code) and _has(everything, without_code), everything

    results = _results(_ok(client, word, has_code="true"))

    assert _has(results, with_code), results
    assert not _has(results, without_code), results


def test_results_are_ranked_by_relevance(client):
    """The paper that matches the query best comes before the ones that match it weakly."""
    word = _word()
    filler = " ".join(f"background{i}" for i in range(60))
    weak = _listed(
        f"Unrelated study {uuid.uuid4().hex}",
        abstract=f"{filler} {word} {filler}",
    )
    medium = _listed(f"Notes on {word}", abstract="A brief note.")
    strong = _listed(f"{word} {word} {word}", abstract=f"{word} {word} {word}")

    results = _results(_ok(client, word))

    strongest = _positions(results, strong)
    assert strongest, f"the best match is missing from {results}"
    for other in (medium, weak):
        later = _positions(results, other)
        assert later, f"{other.title!r} matches {word!r} but is missing from {results}"
        assert strongest[0] < later[0], (
            f"{strong.title!r} (a title and abstract full of {word!r}) must rank above "
            f"{other.title!r}: {results}"
        )
