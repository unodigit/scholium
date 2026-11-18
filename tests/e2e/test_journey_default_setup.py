"""Journey: the default setup, with no worker and no configuration beyond file paths.

``JOBS_EAGER`` unset means eager jobs: a job that is due runs inline, inside the
request that queued it, so a single ``python -m app`` is the whole node.  This is
what a fresh checkout, ``npm test`` and a laptop run, so a paper must get from
submission to the moderation queue and the public catalog with nothing but the
API process alive.
"""

from __future__ import annotations

import pytest

from e2e_harness import assert_bytes_match_cid, json_of, publish_listed_paper


@pytest.fixture(scope="module")
def eager(nodes):
    node = nodes.make("default", storage="fs", jobs="eager", JOBS_MODE=None)  # JOBS_MODE unset: the default
    node.init_key()
    node.start_api()
    assert node.worker is None
    return node


@pytest.fixture(scope="module")
def published(eager):
    with eager.client() as http:
        yield http, publish_listed_paper(eager, http, title="Default setup paper", wait=20)


def test_a_paper_is_scanned_and_listed_with_only_the_api_running(eager, published):
    http, paper = published
    listed = json_of(http.get(f"/v1/papers/{paper.short_id}"))
    assert listed["versionCid"] == paper.version_cid and listed["title"] == paper.title
    assert eager.worker is None and len(eager.extra) == 0


def test_the_manuscript_text_was_extracted_inline(published):
    http, paper = published
    text = json_of(http.get(f"/v1/papers/{paper.short_id}/v/1/text"))
    assert any(paper.sentence in p["text"] for p in text["paragraphs"]), text


def test_the_bytes_are_files_under_content_dir_named_by_their_cid(eager, published):
    http, paper = published
    stored = eager.content_dir / paper.file_cid
    assert stored.is_file() and stored.read_bytes() == paper.pdf
    served = http.get(f"/v1/content/{paper.file_cid}")
    assert served.status_code == 200
    assert_bytes_match_cid(served.content, paper.file_cid)
    # Nothing stays in the staging directories once an upload is finished.
    staged = [p for p in (eager.content_dir / ".tmp").glob("*")] if (eager.content_dir / ".tmp").exists() else []
    assert staged == [], staged


def test_the_settings_say_eager_without_being_told(eager):
    # JOBS_MODE was not set for this node: eager is what an unconfigured node does.
    assert "JOBS_MODE" not in eager.settings()
    assert "JOBS_EAGER" not in eager.settings()
