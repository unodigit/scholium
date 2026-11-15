"""Acceptance tests for: API exposes GET /v1/papers that returns listed papers with
tab latest or reviewed, category filter, sort newest, recently_reviewed or
recently_updated and cursor pagination, without any vote counts (catalog plugin,
feature 82).

Criteria (app_spec.xml, feature 82):

* GET /v1/papers?tab=reviewed returns only papers with status reviewed.
* GET /v1/papers?category=cs.AI returns only cs.AI papers.

The first two tests below are those criteria, one each.  The rest cover the
feature line -- only *listed* papers are returned, ``sort=newest`` and
``sort=recently_updated`` order the list, cursor pagination walks every paper
once, and no vote counts appear -- and assert nothing beyond it.

What is *not* tested, on purpose
--------------------------------

* The *order* of ``sort=recently_reviewed``.  A paper's "last reviewed" instant
  comes from its review records, and neither the criteria nor the spec say which
  record or timestamp it is; the scene sets a paper's status directly (below),
  so there are no review records to order by.  The test only checks that the
  named value is accepted.
* ``tab=following`` (feature 179) and the default ``tab``/``sort`` when none is
  given: the feature line names the values, not the defaults.
* The page-size parameter.  The feature line says "cursor pagination" and so
  fixes ``cursor``; it does not name a size parameter.  The pagination test sends
  ``limit`` -- the usual name -- but asserts nothing that depends on it being
  honoured: it walks every page the response links to and checks that each scene
  paper turns up exactly once, in order.

How the scene is set up
-----------------------

The papers belong to the submissions plugin, whose ``POST /v1/records`` handlers
are guarded by tier, endorsement, consent and moderation rules that have nothing
to do with listing papers.  So the scene is put in place the way the sibling
suites do it:

* a ``paper.genesis``, a ``manifest`` and one ``paper.version`` record per
  version, each correctly signed and appended to the event log;
* the paper and its versions indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make.
  ``save_paper`` takes the paper's ``status``, which is how a paper is made
  ``reviewed`` without depending on the status plugin's ledger subscription (a
  later feature);
* a version is *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``), which is what a moderator's
  decision ends up calling.  It stamps ``listed_at`` -- and takes the instant
  to stamp, which is how the ordering tests give each paper a known age.

Everything the criteria are about goes through the public surface: an anonymous
``GET /v1/papers``.

Reading the response
--------------------

The criteria fix *which papers* come back, and the feature line fixes their
order and the cursor; they do not fix the JSON layout.  The helpers below
therefore find the paper list under any of the usual keys (``items``,
``results``, ``papers``, ...) or as a bare array, find the next-page cursor under
any of the usual names, and recognise a paper as a scene paper by any of its ids
(``sch:`` id, paper cid, version cid) or by the unique tag in its title wherever
the item carries them.  A paper is identified by what the response says and
never by the shape around it.

Every test shares one database with the others, so each asserts on its own
papers and never on totals.  Wherever a response contains a paper from another
test, it is judged by what *that* test made it (its status, its categories,
whether it is listed) -- so a leak shows up whichever test built the paper.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, NamedTuple, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import ledger
from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

PAPERS_URL = "/v1/papers"
LICENCE = "CC-BY-4.0"

#: The states a version walks through on its way to being listed.
_BEFORE_LISTED = ("scanning", "moderation")


# --------------------------------------------------------------------------- #
# The scene: papers whose versions are, or are not, listed
# --------------------------------------------------------------------------- #

#: Every scene paper by every id a response may name it with, and by its tag.
_BY_ID: dict[str, "ScenePaper"] = {}
_BY_TAG: dict[str, "ScenePaper"] = {}

_TAG = re.compile(r"[0-9a-f]{32}")


class Version(NamedTuple):
    """One version of a scene paper."""

    n: int
    cid: str
    title: str


class ScenePaper:
    """A paper started by a ``paper.genesis`` whose versions the test adds one by one.

    Starting a paper leaves it unlisted: it has a ``papers`` row (with the given
    ``status``) and a genesis in the log, no version, and nothing listed.
    :meth:`add_version` stores the next version and :meth:`list_version` lists it.
    """

    def __init__(
        self, *, categories: tuple[str, ...] = ("cs.CR",), status: str = "preprint"
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.status = status
        self._key = SigningKey.generate()
        self.author_did = did_key_from_signing_key(self._key)
        self.versions: list[Version] = []
        self._listed: set[str] = set()

        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance paper {self.tag}",
                "abstract": "A paper readers find in the catalog listing.",
                "categories": self.categories,
                "licence": LICENCE,
                "authors": [self.author_did],
            },
        )
        ledger.append(self.genesis)
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence=LICENCE,
            status=status,
        )
        #: The ``sch:xxxx-xxxx-xxxx`` id of the paper.
        self.short_id = derive_short_id(self.genesis["id"])

        _BY_TAG[self.tag] = self
        _BY_ID[self.short_id] = self
        _BY_ID[self.genesis["id"]] = self

    def __repr__(self) -> str:  # pragma: no cover - failure messages only
        return f"<{self.short_id} {self.status} {self.categories} listed={self.is_listed}>"

    @property
    def is_listed(self) -> bool:
        """Whether any version of the paper is currently listed."""
        return bool(self._listed)

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

    # -- versions -------------------------------------------------------- #

    def add_version(self, state: str = AWAITING_CONSENT) -> Version:
        """Store the paper's next version and leave it in ``state`` (never listed here)."""
        n = len(self.versions) + 1
        prev = self.versions[-1].cid if self.versions else self.genesis["id"]
        title = f"Acceptance paper {self.tag} -- version {n}"
        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag} v{n}".encode()

        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        record = self._sign(
            "paper.version",
            {
                "paper": self.genesis["id"],
                "n": n,
                "title": title,
                "abstract": f"What changed in version {n} of paper {self.tag}.",
                "authors": [
                    {"did": self.author_did, "position": 1, "creditRoles": ["Conceptualization"]}
                ],
                "manifest": manifest["id"],
                "licence": LICENCE,
                "changeNote": f"Version {n}.",
            },
            prev=prev,
        )
        ledger.append(manifest)
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=f"What changed in version {n} of paper {self.tag}.",
            manifest_cid=manifest["id"],
            licence=LICENCE,
            prev_cid=prev,
            change_note=f"Version {n}.",
            authors=(VersionAuthor(self.author_did, 1, ("Conceptualization",)),),
        )
        version = Version(n=n, cid=record["id"], title=title)
        self.versions.append(version)
        _BY_ID[version.cid] = self
        _BY_ID[f"{self.short_id}/v{n}"] = self
        if state != AWAITING_CONSENT:
            transition_version(version.cid, state)
        return version

    def list_version(self, version: Version, at: Optional[datetime] = None) -> None:
        """Take ``version`` through scanning and moderation to ``listed`` (at ``at``)."""
        for state in _BEFORE_LISTED:
            transition_version(version.cid, state)
        transition_version(version.cid, "listed", at=at)
        self._listed.add(version.cid)

    def hold_version(self, version: Version) -> None:
        """A moderator holds a listed ``version``: it leaves the catalog."""
        transition_version(version.cid, "held")
        self._listed.discard(version.cid)


def make_listed(
    *,
    categories: tuple[str, ...] = ("cs.CR",),
    status: str = "preprint",
    listed_at: Optional[datetime] = None,
) -> ScenePaper:
    """A paper with one listed version, listed at ``listed_at`` (default: now)."""
    paper = ScenePaper(categories=categories, status=status)
    paper.list_version(paper.add_version(), at=listed_at)
    return paper


def hours_ago(hours: float) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours)


# --------------------------------------------------------------------------- #
# Reading a response
# --------------------------------------------------------------------------- #

_LIST_KEYS = ("items", "results", "papers", "data", "records", "hits")
#: Names a "next page" cursor goes by; ``cursor`` itself is only a fallback,
#: since a response may echo the cursor of the page it is.
_NEXT_KEYS = ("next_cursor", "nextCursor", "next_page_cursor", "next")
_MAX_PAGES = 200


class Page(NamedTuple):
    body: Any
    items: list[dict]


def _scopes(body: Any) -> list[dict]:
    """The response object followed by every object nested directly inside it."""
    if not isinstance(body, dict):
        return []
    return [body] + [value for value in body.values() if isinstance(value, dict)]


def _items_of(body: Any) -> Optional[list[dict]]:
    """The list of papers in a response, wherever it sits; ``None`` when there is none."""
    if isinstance(body, list):
        return body if all(isinstance(item, dict) for item in body) else None
    if not isinstance(body, dict):
        return None
    for key in _LIST_KEYS:
        value = body.get(key)
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
    lists = [
        value
        for value in body.values()
        if isinstance(value, list) and all(isinstance(item, dict) for item in value)
    ]
    return lists[0] if len(lists) == 1 else None


def _next_cursor(body: Any) -> Optional[str]:
    """The cursor of the next page, or ``None`` when this is the last page."""
    for scope in _scopes(body):
        for key in _NEXT_KEYS:
            if key in scope:
                value = scope[key]
                return value if isinstance(value, str) and value else None
    for scope in _scopes(body):
        value = scope.get("cursor")
        if isinstance(value, str) and value:
            return value
    return None


def _get(client, params: Optional[dict] = None):
    return client.get(PAPERS_URL, params=params or {})


def _walk(client, params: Optional[dict] = None, *, limit: Optional[int] = None) -> list[Page]:
    """``GET /v1/papers`` page after page, following the cursor to the last page."""
    query = dict(params or {})
    if limit is not None:
        query["limit"] = limit
    pages: list[Page] = []
    seen: set[str] = set()
    cursor: Optional[str] = None
    for _ in range(_MAX_PAGES):
        page_query = dict(query)
        if cursor:
            page_query["cursor"] = cursor
        response = _get(client, page_query)
        assert response.status_code == 200, (
            f"GET {PAPERS_URL} {page_query} -> {response.status_code}: {response.text}"
        )
        body = response.json()
        items = _items_of(body)
        assert items is not None, f"GET {PAPERS_URL} {page_query} has no list of papers: {body}"
        pages.append(Page(body, items))
        cursor = _next_cursor(body)
        if not cursor:
            return pages
        assert cursor not in seen, f"the cursor {cursor!r} was handed out twice: {body}"
        seen.add(cursor)
    raise AssertionError(f"GET {PAPERS_URL} {query} still had a next page after {_MAX_PAGES} pages")


def _flatten(pages: list[Page]) -> list[dict]:
    return [item for page in pages for item in page.items]


def _strings(value: Any, depth: int = 0) -> Iterator[str]:
    """Every string inside ``value``, a few levels deep."""
    if isinstance(value, str):
        yield value
    elif depth < 4 and isinstance(value, dict):
        for inner in value.values():
            yield from _strings(inner, depth + 1)
    elif depth < 4 and isinstance(value, list):
        for inner in value:
            yield from _strings(inner, depth + 1)


def _owner(item: dict) -> Optional[ScenePaper]:
    """The scene paper a listed item is, by any id or tag it carries; else ``None``."""
    for text in _strings(item):
        paper = _BY_ID.get(text)
        if paper is not None:
            return paper
        for tag in _TAG.findall(text):
            paper = _BY_TAG.get(tag)
            if paper is not None:
                return paper
    return None


def _owners(items: list[dict]) -> list[ScenePaper]:
    """The scene papers in ``items``, in the order listed (items of no scene paper dropped)."""
    return [paper for paper in map(_owner, items) if paper is not None]


def _item_field(item: dict, name: str) -> Any:
    """``name`` on the item itself, else on a ``paper`` object nested in it, else ``None``."""
    for scope in (item, item.get("paper")):
        if isinstance(scope, dict) and name in scope:
            return scope[name]
    return None


def _label(papers) -> list[str]:
    return [f"{p.short_id} ({p.status}, {','.join(p.categories)})" for p in papers]


def _assert_present(items: list[dict], papers: list[ScenePaper], what: str) -> None:
    present = set(_owners(items))
    missing = [p for p in papers if p not in present]
    assert not missing, f"{what}: the response lacks {_label(missing)}"


def _assert_absent(items: list[dict], papers: list[ScenePaper], what: str) -> None:
    present = set(_owners(items))
    leaked = [p for p in papers if p in present]
    assert not leaked, f"{what}: the response wrongly returns {_label(leaked)}"


def _assert_relative_order(items: list[dict], expected: list[ScenePaper], what: str) -> None:
    """The ``expected`` papers appear once each, in this order, among the items."""
    _assert_present(items, expected, what)
    seen = [p for p in _owners(items) if p in expected]
    assert seen == expected, (
        f"{what}: expected the order {_label(expected)}, the response lists {_label(seen)}"
    )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_tab_reviewed_returns_only_papers_with_status_reviewed(client):
    """GET /v1/papers?tab=reviewed returns only papers with status reviewed."""
    reviewed = [
        make_listed(status="reviewed"),
        make_listed(status="reviewed", categories=("cs.AI",)),
    ]
    not_reviewed = [
        make_listed(status=status)
        for status in ("preprint", "under_review", "contested", "corrected")
    ]

    items = _flatten(_walk(client, {"tab": "reviewed"}))

    _assert_present(items, reviewed, "tab=reviewed")
    _assert_absent(items, not_reviewed, "tab=reviewed")
    # Whatever else the response holds -- papers other tests built included --
    # is reviewed, by what its builder made it and by what the item itself says.
    for item in items:
        paper = _owner(item)
        if paper is not None:
            assert paper.status == "reviewed", (
                f"tab=reviewed returned {_label([paper])}"
            )
        status = _item_field(item, "status")
        if isinstance(status, str):
            assert status == "reviewed", f"tab=reviewed returned an item with status {status!r}: {item}"


def test_category_filter_returns_only_cs_ai_papers(client):
    """GET /v1/papers?category=cs.AI returns only cs.AI papers."""
    cs_ai = [
        make_listed(categories=("cs.AI",)),
        make_listed(categories=("cs.AI",), status="reviewed"),
    ]
    other = [make_listed(categories=("cs.CR",)), make_listed(categories=("cs.LG",))]

    items = _flatten(_walk(client, {"category": "cs.AI"}))

    _assert_present(items, cs_ai, "category=cs.AI")
    _assert_absent(items, other, "category=cs.AI")
    # Whatever else the response holds is a cs.AI paper, by what its builder made
    # it and by what the item itself says.
    for item in items:
        paper = _owner(item)
        if paper is not None:
            assert "cs.AI" in paper.categories, f"category=cs.AI returned {_label([paper])}"
        categories = _item_field(item, "categories")
        if isinstance(categories, list) and all(isinstance(c, str) for c in categories):
            assert "cs.AI" in categories, (
                f"category=cs.AI returned an item in {categories}: {item}"
            )


# --------------------------------------------------------------------------- #
# The rest of the feature line
# --------------------------------------------------------------------------- #


def test_only_listed_papers_are_returned(client):
    """The list holds listed papers: a paper without a listed version is never in it."""
    listed_preprint = make_listed()
    listed_reviewed = make_listed(status="reviewed")

    # Reviewed (so the reviewed tab would take them) but not in the catalog.
    awaiting = ScenePaper(status="reviewed")
    awaiting.add_version()  # awaiting_consent
    in_draft = ScenePaper(status="reviewed")
    in_draft.add_version(state="draft")
    in_moderation = ScenePaper(status="reviewed")
    in_moderation.add_version(state="moderation")
    bare = ScenePaper(status="reviewed")  # started, no version at all
    held = ScenePaper(status="reviewed")
    held.list_version(held.add_version())
    held.hold_version(held.versions[0])
    unlisted = [awaiting, in_draft, in_moderation, bare, held]

    latest = _flatten(_walk(client, {"tab": "latest"}))
    _assert_present(latest, [listed_preprint, listed_reviewed], "tab=latest")
    _assert_absent(latest, unlisted, "tab=latest")

    reviewed = _flatten(_walk(client, {"tab": "reviewed"}))
    _assert_present(reviewed, [listed_reviewed], "tab=reviewed")
    _assert_absent(reviewed, unlisted, "tab=reviewed")

    # Nothing the catalog lists is a paper that is not listed, whatever its builder.
    for item in latest + reviewed:
        paper = _owner(item)
        if paper is not None:
            assert paper.is_listed, f"the list returned an unlisted paper {_label([paper])}"


def test_sort_newest_lists_the_most_recently_listed_paper_first(client):
    """sort=newest orders papers newest first."""
    # Built out of age order, so that neither insertion order nor id order is the answer.
    ages = {"third": 3, "first": 1, "fourth": 4, "second": 2}
    papers = {name: make_listed(listed_at=hours_ago(h)) for name, h in ages.items()}
    newest_first = [papers[name] for name in ("first", "second", "third", "fourth")]

    items = _flatten(_walk(client, {"sort": "newest"}))

    _assert_relative_order(items, newest_first, "sort=newest")


def test_sort_recently_updated_lists_the_paper_with_the_newest_version_first(client):
    """sort=recently_updated puts the paper whose version was listed last first."""
    oldest = make_listed(listed_at=hours_ago(30))
    middle = make_listed(listed_at=hours_ago(20))
    newest = make_listed(listed_at=hours_ago(10))
    # The oldest paper gets a second version listed just now: it is the one
    # most recently updated, though it was first published long before the others.
    oldest.list_version(oldest.add_version())

    items = _flatten(_walk(client, {"sort": "recently_updated"}))

    _assert_relative_order(items, [oldest, newest, middle], "sort=recently_updated")


@pytest.mark.parametrize("sort", ["newest", "recently_reviewed", "recently_updated"])
def test_each_named_sort_is_accepted(client, sort):
    """sort=newest, sort=recently_reviewed and sort=recently_updated are all valid."""
    make_listed(status="reviewed")

    response = _get(client, {"sort": sort})

    assert response.status_code == 200, f"sort={sort} -> {response.status_code}: {response.text}"
    assert _items_of(response.json()) is not None, response.json()


def test_cursor_pagination_returns_every_paper_exactly_once_in_order(client):
    """Following the cursor from page to page yields each paper once, in sort order."""
    ages = [5, 1, 4, 2, 3, 6]  # built out of age order
    papers = {h: make_listed(listed_at=hours_ago(h)) for h in ages}
    newest_first = [papers[h] for h in sorted(ages)]

    pages = _walk(client, {"sort": "newest"}, limit=2)
    items = _flatten(pages)

    _assert_relative_order(items, newest_first, "sort=newest, paged")
    counts = Counter(_owners(items))
    repeated = [p for p, n in counts.items() if n > 1]
    assert not repeated, f"papers returned on more than one page: {_label(repeated)}"
    # A page that is not the last one must be able to say where the next begins:
    # _walk follows exactly that cursor, so reaching every paper above proves it.
    assert all(page.items for page in pages[:-1]), "a page before the last one was empty"


def test_no_vote_counts_in_the_response(client):
    """The response carries no vote (or like) counts on any paper."""
    papers = [make_listed(status="reviewed"), make_listed()]

    pages = _walk(client, {"tab": "latest"}) + _walk(client, {"tab": "reviewed"})

    # There is something to inspect: the scene's own papers are in the response.
    _assert_present(_flatten(pages), papers[:1], "tab=reviewed")
    _assert_present(_flatten(pages), papers, "tab=latest")
    offending = sorted({key for page in pages for key in _vote_keys(page.body)})
    assert not offending, f"the response carries vote/like fields: {offending}"


_VOTE_WORDS = {"vote", "votes", "upvote", "upvotes", "downvote", "downvotes", "like", "likes"}


def _vote_keys(value: Any) -> Iterator[str]:
    """Every object key, at any depth, one of whose words is a vote or like word."""
    if isinstance(value, dict):
        for key, inner in value.items():
            words = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower()
            if _VOTE_WORDS & set(re.split(r"[^a-z0-9]+", words)):
                yield str(key)
            yield from _vote_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _vote_keys(inner)
