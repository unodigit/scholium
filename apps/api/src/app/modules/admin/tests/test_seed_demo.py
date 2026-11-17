"""``python -m app.modules.admin seed-demo`` (feature 129).

The cast, manuscripts and keys file are checked on their own; the command is
run against a hermetic node (its own database, node key and content directory),
once through the CLI to see what it prints and leaves behind, and once as a real
process with the record core made unimportable, as in a plain ``uv run``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, verify_record
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app import db
from app.modules import ledger, moderation, reviews
from app.modules.admin.cli import DEFAULT_KEYS_FILE, build_parser, main
from app.modules.admin.demo.cast import PAPERS, PEOPLE, RUBRIC, DemoPaper, people_by_slug
from app.modules.admin.demo.keys import FORMAT_VERSION, DemoKeys, DemoKeysError
from app.modules.admin.demo.manuscript import build_pdf
from app.modules.admin.demo.seed import SeedError, SeedResult, _Actor, _outcome, _Seeder, seed_demo
from app.modules.ai_review.background import ensure_subscribed as ensure_ai_review
from app.modules.ledger.origin import node_signing_key
from app.modules.checks.extract import extract_paragraphs
from app.modules.ingest import DUPLICATE_RECORD
from app.modules.notifications import clear_outbox
from app.modules.sanitizer.pdf import scan_pdf_bytes
from app.settings import settings

SRC = Path(__file__).resolve().parents[4]
SHORT_ID = re.compile(r"sch:[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}")
NAMES = {person.slug: person.name for person in PEOPLE}


# --- a hermetic node --------------------------------------------------------


@pytest.fixture
def node(tmp_path, monkeypatch):
    """A node of its own: fresh database, node key, content directory and outbox.

    Like the journey tests' node, because ``seed-demo`` drives the same app.
    """
    engine = create_engine(
        f"sqlite:///{tmp_path / 'node.db'}", connect_args={"check_same_thread": False}, future=True
    )
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(
        db, "SessionLocal", sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    )
    key_file = tmp_path / "node.key"
    key_file.write_text(SigningKey.generate().encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(key_file))
    monkeypatch.setattr(settings, "CONTENT_DIR", str(tmp_path / "content"))
    monkeypatch.setattr(settings, "JWT_SECRET", "seed-demo-test-secret-" + "x" * 64)
    monkeypatch.setattr(settings, "SCHOLIUM_ENV", "dev")
    clear_outbox()
    # The subscriber registries outlive one app and other suites clear them; a
    # fresh process has them, so only a test needs to put them back.
    ledger.subscribe(moderation.DECISION_TYPE, moderation.persist_entry)
    reviews._install_ledger_subscriber()
    ensure_ai_review()
    yield SimpleNamespace(engine=engine, root=tmp_path, db_path=tmp_path / "node.db")
    clear_outbox()
    engine.dispose()


def rows(node, sql: str, **params):
    with node.engine.connect() as conn:
        return conn.execute(text(sql), params).fetchall()


@pytest.fixture
def posted(monkeypatch):
    """Every record the seeder submits, as ``(url, record)``, captured on its way to the node."""
    captured: list[tuple[str, dict]] = []
    original = TestClient.post

    def spy(self, url, *args, **kwargs):
        if url in ("/v1/records", "/v1/reviews/commit", "/v1/reviews/reveal"):
            captured.append((url, kwargs["json"]))
        return original(self, url, *args, **kwargs)

    monkeypatch.setattr(TestClient, "post", spy)
    return captured


# --- the command ------------------------------------------------------------


def test_seed_demo_loads_the_cast_signs_client_side_and_prints_the_sch_ids(node, posted, capsys):
    keys_file = node.root / ".demo-keys.json"

    assert main(["seed-demo", "--keys-file", str(keys_file)]) == 0
    out, err = capsys.readouterr()

    # The sch: ids it prints are the papers the node now holds -- one per demo paper.
    printed = set(SHORT_ID.findall(out))
    stored = {short_id for (short_id,) in rows(node, "select short_id from papers")}
    assert printed == stored and len(stored) == len(PAPERS)
    for paper in PAPERS:
        assert paper.title in out

    # The keys file holds a key for every account, each the did:key it names, readable by its owner only.
    document = json.loads(keys_file.read_text())
    assert document["version"] == FORMAT_VERSION
    assert set(document["accounts"]) == {person.slug for person in PEOPLE}
    assert stat.S_IMODE(keys_file.stat().st_mode) == 0o600
    seeds = []
    for entry in document["accounts"].values():
        assert did_key_from_signing_key(SigningKey(bytes.fromhex(entry["seed"]))) == entry["did"]
        seeds.append(entry["seed"])
    dids = {slug: entry["did"] for slug, entry in document["accounts"].items()}

    # Everyone is what the cast says: reviewers and the moderator appointed, authors endorsed.
    for person in PEOPLE:
        assert rows(node, "select tier from accounts where did = :d", d=dids[person.slug]) == [(person.tier,)]
    endorsed = {(d, c) for d, c in rows(node, "select endorsee_did, category from endorsements")}
    for person in PEOPLE:
        assert {(dids[person.slug], category) for category in person.endorsed_in} <= endorsed

    # Two papers are listed; the out-of-scope one waits in the moderation queue.
    states = dict(rows(node, "select title, state from paper_versions"))
    assert states == {paper.title: ("listed" if paper.listed else "moderation") for paper in PAPERS}

    # Reviews: committed for all, opened for the ones the cast says.
    assert rows(node, "select count(*), sum(revealed_at is not null) from review") == [
        (sum(len(p.reviews) for p in PAPERS), sum(r.reveal for p in PAPERS for r in p.reviews))
    ]

    # The node's own background work ran: scanned (renditions) and pre-reviewed (listed papers only).
    kinds = dict(rows(node, "select record_type, count(*) from event_log group by record_type"))
    assert kinds["rendition"] == len(PAPERS)
    assert kinds["ai.review"] == sum(p.listed for p in PAPERS)

    # Every record was signed here, before it reached the node, by the key in the keys file;
    # a review's records by a throwaway key that names nobody.
    assert len(posted) > 0
    for url, record in posted:
        assert verify_record(record), (url, record["type"])
        if url == "/v1/records":
            assert record["author"] in dids.values(), record["type"]
        else:
            assert record["author"] not in dids.values(), record["type"]
    assert {record["type"] for _, record in posted} >= {
        "endorsement", "manifest", "paper.genesis", "paper.version", "coauthor.consent",
        "moderation.decision", "review.commit", "review.formal",
    }  # fmt: skip

    # The seeds are the keys' secret: they went nowhere but the keys file.
    dump = "\n".join(sqlite3.connect(node.db_path).iterdump())
    for seed in seeds:
        assert seed not in dump and seed not in out and seed not in err


def test_running_seed_demo_again_adds_nothing(node):
    keys_file = node.root / ".demo-keys.json"
    first = seed_demo(keys_file)
    log_before = rows(node, "select record_type, count(*) from event_log group by record_type order by 1")

    second = seed_demo(keys_file)

    assert [p.short_id for p in second.papers] == [p.short_id for p in first.papers]
    assert all(p.created for p in first.papers)
    assert not any(p.created for p in second.papers)
    assert [a.did for a in second.accounts] == [a.did for a in first.accounts]
    assert (second.papers[0].reviews_revealed, second.papers[0].reviews_sealed) == (1, 1)
    assert rows(node, "select record_type, count(*) from event_log group by record_type order by 1") == log_before
    assert not second.keys_created


def test_short_ids_are_the_ones_derived_from_the_genesis_records(node):
    result = seed_demo(node.root / ".demo-keys.json")

    for paper in result.papers:
        assert paper.short_id == derive_short_id(paper.paper_cid)


def test_a_production_node_is_refused_and_nothing_is_written(node, monkeypatch, capsys):
    monkeypatch.setattr(settings, "SCHOLIUM_ENV", "production")
    keys_file = node.root / ".demo-keys.json"

    with pytest.raises(SeedError, match="production"):
        seed_demo(keys_file)
    assert main(["seed-demo", "--keys-file", str(keys_file)]) == 1

    assert "production" in capsys.readouterr().err
    assert not keys_file.exists()
    assert rows(node, "select name from sqlite_master where name = 'accounts'") == []


def test_settings_are_pinned_for_the_run_and_restored_after_a_failure(node, monkeypatch):
    for name, value in {"AI_PROVIDER": "anthropic", "SMTP_URL": "smtp://mail.example", "JOBS_EAGER": 0,
                        "RATE_LIMIT_ENABLED": 1}.items():  # fmt: skip
        monkeypatch.setattr(settings, name, value)
    seen = {}

    def run_and_fail(self):
        seen.update({n: getattr(settings, n) for n in ("AI_PROVIDER", "SMTP_URL", "JOBS_EAGER", "RATE_LIMIT_ENABLED")})
        raise SeedError("boom")

    monkeypatch.setattr(_Seeder, "run", run_and_fail)
    keys_file = node.root / ".demo-keys.json"
    log: list[str] = []

    with pytest.raises(SeedError, match="boom"):
        seed_demo(keys_file, log=log.append)

    assert seen == {"AI_PROVIDER": "fake", "SMTP_URL": "", "JOBS_EAGER": 1, "RATE_LIMIT_ENABLED": 0}
    assert (settings.AI_PROVIDER, settings.SMTP_URL) == ("anthropic", "smtp://mail.example")
    assert (settings.JOBS_EAGER, settings.RATE_LIMIT_ENABLED) == (0, 1)
    assert any("AI_PROVIDER" in line for line in log) and any("SMTP_URL" in line for line in log)
    # The keys were on disk before the node was touched, so a failed run loses none.
    assert set(json.loads(keys_file.read_text())["accounts"]) == {person.slug for person in PEOPLE}


def test_a_missing_node_key_is_made_so_the_node_can_sign(node, monkeypatch):
    """A demo node is disposable, so the run gives one its key rather than skip signing."""
    absent = node.root / "absent.key"
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(absent))
    log: list[str] = []

    result = seed_demo(node.root / ".demo-keys.json", log=log.append)

    assert any("created the node signing key" in line for line in log)
    assert stat.S_IMODE(absent.stat().st_mode) == 0o600
    assert node_signing_key(str(absent)) is not None
    assert result.node_key_created is not None and result.node_key_created.samefile(absent)
    assert {p.state for p in result.papers} == {"listed", "moderation"}  # the run still completes
    # ... and this time the node could sign what it is there to sign.
    assert rows(node, "select count(*) from event_log where record_type = 'rendition'") == [(len(PAPERS),)]
    assert sum(p.ai_reviewed for p in result.papers) == sum(p.state == "listed" for p in result.papers)


def test_an_unusable_node_key_is_kept_and_the_summary_claims_nothing_unsigned(node, monkeypatch, capsys):
    """An existing key file is the operator's: noted, never replaced -- and the summary says only what happened."""
    garbage = node.root / "garbage.key"
    garbage.write_text("definitely not an Ed25519 key")
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(garbage))

    assert main(["seed-demo", "--keys-file", str(node.root / ".demo-keys.json")]) == 0
    out, err = capsys.readouterr()

    assert garbage.read_text() == "definitely not an Ed25519 key"
    assert "no usable node signing key" in err
    # The node signed nothing of its own, so the summary does not say it did:
    # the pre-review endpoint answers from the node's tables, which the job
    # fills in even when no record could be signed.
    assert rows(node, "select count(*) from event_log where record_type = 'rendition'") == [(0,)]
    assert "AI pre-review" not in out


@pytest.fixture
def noisy_node(node, monkeypatch):
    """A run during which a background job fails and logs a traceback, as the AI agents do."""

    def run(self):
        try:
            raise ValueError("agent reply has no findings")
        except ValueError:
            logging.getLogger("app.modules.some_plugin").warning(
                "agent methodology failed for bafyreicxeakecwb6uew5uv4zfqmhhqktgafl2jrcfu2zb42grn2pexuwai",
                exc_info=True,
            )

    monkeypatch.setattr(_Seeder, "run", run)
    return node


def _collectors() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if type(h).__name__ == "_NodeLogCollector"]


def test_what_the_node_logs_meanwhile_is_tallied_by_headline_not_printed(noisy_node, capsys):
    result = seed_demo(noisy_node.root / ".demo-keys.json")

    assert result.node_log == {"agent methodology failed for <cid>": 1}
    assert "Traceback" not in capsys.readouterr().err
    assert _collectors() == []


def test_verbose_leaves_the_node_log_alone(noisy_node):
    result = seed_demo(noisy_node.root / ".demo-keys.json", verbose=True)

    assert result.node_log == {}


def test_the_collector_is_removed_even_when_the_run_fails(node, monkeypatch):
    monkeypatch.setattr(_Seeder, "run", lambda self: (_ for _ in ()).throw(SeedError("boom")))

    with pytest.raises(SeedError):
        seed_demo(node.root / ".demo-keys.json")

    assert _collectors() == []


def test_when_the_run_fails_what_the_node_logged_is_reported_with_it(noisy_node, monkeypatch):
    """A failure's cause can live only in the node's log (a held scan, say), so it must not be swallowed."""
    noisy_run = _Seeder.run

    def log_then_fail(self):
        noisy_run(self)
        raise SeedError("the scan held the manuscript")

    monkeypatch.setattr(_Seeder, "run", log_then_fail)
    log: list[str] = []

    with pytest.raises(SeedError, match="held the manuscript"):
        seed_demo(noisy_node.root / ".demo-keys.json", log=log.append)

    assert "node log: 1x agent methodology failed for <cid>" in log


def test_the_cli_summarises_the_node_log_unless_verbose(noisy_node, capsys):
    keys = str(noisy_node.root / ".demo-keys.json")

    assert main(["seed-demo", "--keys-file", keys]) == 0
    err = capsys.readouterr().err
    assert "the node logged 1 warnings or errors" in err and "1x agent methodology failed for <cid>" in err

    assert main(["seed-demo", "--keys-file", keys, "--verbose"]) == 0
    assert "the node logged" not in capsys.readouterr().err


def test_a_broken_keys_file_is_an_error_not_a_fresh_start(node, capsys):
    keys_file = node.root / ".demo-keys.json"
    keys_file.write_text("{ not json")

    assert main(["seed-demo", "--keys-file", str(keys_file)]) == 1

    assert "not valid JSON" in capsys.readouterr().err
    assert keys_file.read_text() == "{ not json"  # the keys it may hold are not thrown away
    assert rows(node, "select name from sqlite_master where name = 'accounts'") == []


def test_the_parser_offers_seed_demo_with_a_keys_file_next_to_where_it_runs():
    parser = build_parser()

    args = parser.parse_args(["seed-demo"])

    assert args.keys_file == Path(DEFAULT_KEYS_FILE) == Path(".demo-keys.json")
    assert args.verbose is False
    assert "seed-demo" in parser.format_help()


# --- as a real process, as in a plain ``uv run`` ----------------------------


# ``uv run python -m app.modules.admin`` installs only the root project, so the
# record core is not importable: drop the editable install's path entry to match.
_FRESH_CHECKOUT = """
import importlib, importlib.util, runpy, sys
sys.path[:] = [p for p in sys.path if "record-core" not in p]
importlib.invalidate_caches()
spec = importlib.util.find_spec("scholium_record_core")
assert spec is None or spec.origin is None, "the record core is still importable"
mode, sys.argv = sys.argv[1], ["python -m app.modules.admin", *sys.argv[2:]]
if mode == "no-workspace":
    from app.modules.admin import bootstrap
    bootstrap._WORKSPACE_SOURCE = bootstrap.Path("/nonexistent/workspace/src")
try:
    runpy.run_module("app.modules.admin", run_name="__main__", alter_sys=True)
finally:
    core = sys.modules.get("scholium_record_core")
    print("record core from:", getattr(core, "__file__", None), file=sys.stderr)
"""


def _plain_uv_run(mode: str, *args: str, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", _FRESH_CHECKOUT, mode, *args],
        env={**os.environ, "PYTHONPATH": str(SRC), **env},
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=240,
    )


def _node_env(root: Path) -> dict[str, str]:
    (root / "node.key").write_text(SigningKey.generate().encode().hex())
    return {
        "DATABASE_URL": f"sqlite:///{root / 'node.db'}",
        "CONTENT_DIR": str(root / "content"),
        "NODE_KEY_PATH": str(root / "node.key"),
        "JWT_SECRET": "seed-demo-test-secret-" + "x" * 64,
        "SCHOLIUM_ENV": "dev",
    }


def test_seed_demo_runs_where_the_record_core_is_not_installed(tmp_path):
    """The command is run as ``uv run python -m app.modules.admin seed-demo``, with no ``--all-packages``."""
    env = _node_env(tmp_path)

    result = _plain_uv_run("normal", "seed-demo", cwd=tmp_path, env=env)

    assert result.returncode == 0, result.stderr[-2000:]
    assert len(set(SHORT_ID.findall(result.stdout))) == len(PAPERS)
    # The keys file landed next to where it ran, as the feature says.
    assert (tmp_path / ".demo-keys.json").is_file()
    # ...and the record core came from the workspace checkout, not an install.
    assert "record-core/src/scholium_record_core" in result.stderr
    with sqlite3.connect(tmp_path / "node.db") as conn:
        assert conn.execute("select count(*) from papers").fetchone() == (len(PAPERS),)


def test_without_the_record_core_or_its_workspace_it_says_how_to_run(tmp_path):
    result = _plain_uv_run("no-workspace", "seed-demo", cwd=tmp_path, env=_node_env(tmp_path))

    assert result.returncode == 1
    assert "uv run --all-packages" in result.stderr
    assert not (tmp_path / ".demo-keys.json").exists()


# --- the cast ---------------------------------------------------------------


def test_the_cast_keeps_to_the_rules_the_node_enforces():
    people = people_by_slug()
    assert len(people) == len(PEOPLE), "duplicate slugs"
    assert len({p.email for p in PEOPLE}) == len(PEOPLE)
    assert [p.role for p in PEOPLE].count("moderator") == 1
    assert {"author", "reviewer"} <= {p.role for p in PEOPLE}

    submitters = [paper.submitter for paper in PAPERS]
    # A young tier-2 author may start one paper a week, and every demo account is new.
    assert len(set(submitters)) == len(submitters)
    assert len({paper.title for paper in PAPERS}) == len(PAPERS)

    for paper in PAPERS:
        authors = {slug for slug, _ in paper.authors}
        assert authors <= people.keys()
        submitter = people[paper.submitter]
        assert submitter.role == "author"
        assert set(paper.categories) <= set(submitter.endorsed_in)
        assert people[submitter.endorsed_by].role == "reviewer"
        institutions = {people[slug].affiliation for slug in authors}
        reviewers = [review.reviewer for review in paper.reviews]
        assert len(set(reviewers)) == len(reviewers), "one review per person per paper"
        for review in paper.reviews:
            reviewer = people[review.reviewer]
            assert reviewer.role == "reviewer"
            assert review.reviewer not in authors
            assert reviewer.affiliation not in institutions
            assert all(people[a].endorsed_by != review.reviewer for a in authors)
            # The node lets a reviewer who holds endorsements review only inside them, and one
            # with none cannot start a paper: so a reviewer is endorsed in what they review.
            assert set(paper.categories) <= set(reviewer.endorsed_in)
            assert people[reviewer.endorsed_by].role == "reviewer"
            assert len(review.scores) == len(RUBRIC) and all(1 <= s <= 5 for s in review.scores)
        assert not paper.reviews or paper.listed, "only a listed paper can be reviewed"


# --- what a person can do on fresh demo data --------------------------------


@pytest.fixture
def seeded(node):
    """A freshly seeded node, and the keys file the cast signs with."""
    keys_file = node.root / ".demo-keys.json"
    result = seed_demo(keys_file)
    return SimpleNamespace(node=node, keys_file=keys_file, result=result)


def _dids(seeded) -> dict[str, str]:
    return {account.slug: account.did for account in DemoKeys.load_or_create(seeded.keys_file).accounts()}


def _start_a_paper(seeded, slug: str, categories: list[str]) -> tuple[int, str | None]:
    """Start a paper as ``slug``: the ``paper.genesis`` step of ``/submit``.

    That is where the node checks the author's tier, their endorsement in every
    category, and the weekly limit on young authors.  Returns the node's status
    and, for a refusal, its problem type.  Runs with the node's own settings, not
    the seed's: the run pinned the write throttle off, a person does not get that.
    """
    from app.main import create_app

    keys = DemoKeys.load_or_create(seeded.keys_file)
    account = next(a for a in keys.accounts() if a.slug == slug)
    with TestClient(create_app()) as http:
        actor = _Actor(http, account)
        actor.sign_in()
        genesis = actor.record(
            "paper.genesis",
            {
                "title": f"A paper started by {account.name} in {', '.join(categories)}",
                "abstract": "Checks that the demo account may start a paper.",
                "categories": categories,
                "licence": "CC-BY-4.0",
                "authors": [account.did],
            },
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        response = http.post("/v1/records", json=genesis, headers=actor.headers)
    problem = None if response.status_code == 201 else response.json().get("type")
    return response.status_code, problem


def test_a_demo_author_with_no_paper_is_endorsed_in_cs_ai_and_cs_lg_and_can_start_one(seeded):
    """The young-author limit holds back everyone who started a seeded paper, so the publish journey needs Ana."""
    ana = people_by_slug()["ana"]
    assert (ana.name, ana.role, ana.tier) == ("Ana Costa", "author", 2)
    assert set(ana.endorsed_in) == {"cs.AI", "cs.LG"}
    assert ana.slug not in {paper.submitter for paper in PAPERS}
    assert all(ana.slug not in {slug for slug, _ in paper.authors} for paper in PAPERS)
    did = _dids(seeded)["ana"]

    assert rows(seeded.node, "select tier from accounts where did = :d", d=did) == [(2,)]
    assert {c for (c,) in rows(seeded.node, "select category from endorsements where endorsee_did = :d", d=did)} == {
        "cs.AI",
        "cs.LG",
    }
    assert rows(
        seeded.node, "select count(*) from event_log where author_did = :d and record_type = 'paper.genesis'", d=did
    ) == [(0,)]
    # Both endorsements are used by one paper filed under both categories.
    assert _start_a_paper(seeded, "ana", ["cs.AI", "cs.LG"]) == (201, None)


def test_ana_can_publish_a_whole_paper_on_fresh_demo_data(seeded):
    """PRD journey 1 minus the browser: upload, manifest, genesis, version, consent and scan, as Ana."""
    from app.main import create_app

    keys = DemoKeys.load_or_create(seeded.keys_file)
    ana_paper = DemoPaper(
        slug="ana-probe",
        title="A Short Note Published From Fresh Demo Data",
        abstract="Checks that a demo author can publish a paper after the seed has run.",
        categories=("cs.AI", "cs.LG"),
        authors=(("ana", ("Conceptualization", "Writing - original draft")),),
        days_ago=0,
        listed=False,
        sections=(("1 Note", ("A fictional paragraph, published by a fictional author.",)),),
    )
    with TestClient(create_app()) as http:
        seeder = _Seeder(http, keys, lambda _message: None, SeedResult("probe", seeded.keys_file, False))
        seeder._sign_in()
        published = seeder._publish(ana_paper)

    assert published.created and published.state == "moderation"
    assert rows(seeded.node, "select state from paper_versions where title = :t", t=ana_paper.title) == [
        ("moderation",)
    ]


def test_each_reviewer_is_endorsed_in_the_categories_of_the_papers_they_reviewed(seeded):
    dids = _dids(seeded)
    endorsed = {(d, c) for d, c in rows(seeded.node, "select endorsee_did, category from endorsements")}
    reviewed: dict[str, set[str]] = {}
    for paper in PAPERS:
        for review in paper.reviews:
            reviewed.setdefault(review.reviewer, set()).update(paper.categories)
    assert reviewed, "the cast has reviews"

    for slug, categories in reviewed.items():
        # Still a reviewer: an endorsement grants tier 2 and never demotes anyone.
        assert rows(seeded.node, "select tier from accounts where did = :d", d=dids[slug]) == [(3,)]
        assert {(dids[slug], category) for category in categories} <= endorsed, slug
        # ... and so a reviewer, who is not held by the weekly limit, can start a paper in each.
        for category in sorted(categories):
            assert _start_a_paper(seeded, slug, [category]) == (201, None), (slug, category)


def _record(seeded, cid: str) -> dict:
    from app.main import create_app

    with TestClient(create_app()) as http:
        response = http.get(f"/v1/records/{cid}")
    assert response.status_code == 200, (cid, response.text)
    return response.json()


def test_a_seeded_version_record_carries_its_papers_categories(seeded):
    """The moderation item page reads ``body.categories`` of the version record, as the browser signs it."""
    assert len(seeded.result.papers) == len(PAPERS)

    for paper, stored in zip(PAPERS, seeded.result.papers):
        body = _record(seeded, stored.version_cid)["body"]
        assert body["categories"] == list(paper.categories), paper.title


# --- manuscripts ------------------------------------------------------------


def _squash(value: str) -> str:
    """``value`` as the node reads it back: PDF's standard encoding draws ``'`` as a typographic ``\u2019``."""
    return " ".join(value.split()).replace("'", "\u2019")


@pytest.mark.parametrize("paper", PAPERS, ids=lambda p: p.slug)
def test_a_manuscript_is_deterministic_passes_the_scan_and_reads_back_as_written(paper):
    pdf = build_pdf(paper.manuscript(NAMES))

    assert pdf == build_pdf(paper.manuscript(NAMES))  # same bytes, so the same content id every run
    assert pdf.startswith(b"%PDF-")
    assert not scan_pdf_bytes(pdf, record=False).failed
    paragraphs = [p.text for p in extract_paragraphs(pdf)]
    assert paper.title in paragraphs
    assert _squash(paper.abstract) in paragraphs
    for _heading, body in paper.sections:
        for paragraph in body:
            assert _squash(paragraph) in paragraphs
    assert any("fictional" in p for p in paragraphs)


def test_a_manuscript_survives_characters_that_pdf_strings_escape():
    from app.modules.admin.demo.manuscript import Manuscript

    pdf = build_pdf(Manuscript("A (parenthetical) \\ title", ("A. Author",), ("cs.AI",), "Abstract (with) parens.", ()))

    assert not scan_pdf_bytes(pdf, record=False).failed
    assert any("A (parenthetical) \\ title" in p.text for p in extract_paragraphs(pdf))


# --- the keys file ----------------------------------------------------------


def test_keys_are_kept_for_the_same_people_and_extended_for_new_ones(tmp_path):
    path = tmp_path / "keys.json"
    first = DemoKeys.load_or_create(path)
    mei = first.account("mei", name="Mei Zhang", role="author")
    first.save()

    again = DemoKeys.load_or_create(path)
    assert not again.created and again.anchor == first.anchor
    assert again.account("mei", name="ignored", role="ignored") == mei
    lena = again.account("lena", name="Lena Haddad", role="author")
    again.save()

    final = DemoKeys.load_or_create(path)
    assert {a.slug: a.did for a in final.accounts()} == {"mei": mei.did, "lena": lena.did}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(tmp_path.glob("*.tmp")) == []  # the atomic write leaves nothing behind


def test_the_history_is_anchored_a_day_before_the_first_run(tmp_path):
    now = datetime(2026, 11, 16, 3, 10, 42, 123456, tzinfo=timezone.utc)

    keys = DemoKeys.load_or_create(tmp_path / "keys.json", now=now)

    assert keys.created
    assert keys.anchor == datetime(2026, 11, 15, 3, 10, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("content", "complaint"),
    [
        ("{ nope", "not valid JSON"),
        ("[]", "not a version"),
        (json.dumps({"version": 99, "anchor": "2026-11-15T00:00:00Z", "accounts": {}}), "not a version"),
        (json.dumps({"version": FORMAT_VERSION, "accounts": {}}), "anchor"),
        (json.dumps({"version": FORMAT_VERSION, "anchor": "2026-11-15T00:00:00Z"}), "accounts"),
        (
            json.dumps({"version": FORMAT_VERSION, "anchor": "2026-11-15T00:00:00Z",
                        "accounts": {"mei": {"name": "Mei", "role": "author", "did": "did:key:z6Mkx", "seed": "00" * 32}}}),
            "does not match",
        ),  # fmt: skip
        (
            json.dumps({"version": FORMAT_VERSION, "anchor": "2026-11-15T00:00:00Z",
                        "accounts": {"mei": {"name": "Mei", "role": "author", "did": "did:key:z6Mkx", "seed": "zz"}}}),
            "invalid seed",
        ),  # fmt: skip
    ],
)
def test_a_keys_file_that_cannot_be_trusted_is_refused_and_left_as_it_was(tmp_path, content, complaint):
    path = tmp_path / "keys.json"
    path.write_text(content)

    with pytest.raises(DemoKeysError, match=complaint):
        DemoKeys.load_or_create(path)

    assert path.read_text() == content


# --- telling a duplicate from a refusal -------------------------------------


class _Response:
    def __init__(self, status: int, body=None):
        self.status_code, self._body, self.text = status, body, json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def test_only_the_named_duplicates_count_as_already_there():
    assert _outcome(_Response(201, {"id": "x"}), "step", (DUPLICATE_RECORD,)) == ({"id": "x"}, False)
    assert _outcome(_Response(409, {"type": DUPLICATE_RECORD}), "step", (DUPLICATE_RECORD,)) == (None, True)

    other_conflict = {"type": "urn:scholium:problem:short-id-collision", "title": "Conflict", "detail": "taken"}
    with pytest.raises(SeedError, match=r"step: the node answered 409 Conflict: taken"):
        _outcome(_Response(409, other_conflict), "step", (DUPLICATE_RECORD,))
    with pytest.raises(SeedError, match=r"step: the node answered 403"):
        _outcome(_Response(403, {"title": "Forbidden", "detail": "tier"}), "step", (DUPLICATE_RECORD,))
    with pytest.raises(SeedError, match=r"step: the node answered 500"):
        _outcome(_Response(500), "step", (DUPLICATE_RECORD,))


def test_a_new_history_is_anchored_in_the_past_so_no_record_is_dated_in_the_future():
    keys = DemoKeys.load_or_create(Path("unused.json"))

    assert keys.anchor < datetime.now(timezone.utc) - timedelta(hours=23)
