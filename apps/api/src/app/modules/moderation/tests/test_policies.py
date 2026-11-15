"""Tests for GET /v1/moderation/policies and the policies.yaml loader.

Covers: the endpoint contract (200, list of clauses with id/title/text),
the bundled policies file, the dependency-free YAML subset parser, the
environment override and validation errors. All parsing tests run
against the same content the shipped policies.yaml uses.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_moderation_policies.db")

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.moderation import (
    POLICIES_YAML_ENV,
    PolicyClause,
    PolicyClauseError,
    bundled_policies_path,
    clear_policy_cache,
    get_clause,
    get_clauses,
    load_clauses,
    parse_yaml_subset,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_policy_cache():
    clear_policy_cache()
    yield
    clear_policy_cache()


def test_endpoint_returns_the_clause_list():
    response = client.get("/v1/moderation/policies")
    assert response.status_code == 200
    clauses = response.json()
    assert isinstance(clauses, list)
    assert len(clauses) >= 1
    for clause in clauses:
        assert set(clause) == {"id", "title", "text"}
        assert all(isinstance(clause[field], str) and clause[field] for field in clause)


def test_endpoint_serves_the_bundled_policies_file():
    body = client.get("/v1/moderation/policies").json()
    expected = [clause.model_dump() for clause in load_clauses()]
    assert body == expected


def test_bundled_file_has_unique_mod_ids():
    clauses = load_clauses()
    ids = [clause.id for clause in clauses]
    assert len(ids) == len(set(ids))
    assert all(clause.id.startswith("MOD-") for clause in clauses)
    first = get_clause("MOD-01")
    assert first is not None and first.title == "Out of scope"
    assert "scholarly" in first.text.lower()
    assert get_clause("no-such-clause") is None


def test_folded_block_scalar_text_is_one_paragraph():
    for clause in load_clauses():
        assert not clause.text.startswith(" ")
        assert not clause.text.endswith("\n")
        assert "\n" not in clause.text
        assert clause.text.strip() == clause.text


def test_env_override_points_at_another_file(monkeypatch, tmp_path):
    custom = tmp_path / "custom_policies.yaml"
    custom.write_text(
        "# custom policy source\n"
        "clauses:\n"
        "  - id: \"CUSTOM-1\"\n"
        "    title: 'Custom clause'\n"
        "    text: >-\n"
        "      Loaded from an\n"
        "      overridden file.\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(POLICIES_YAML_ENV, str(custom))
    clauses = get_clauses()
    assert [clause.id for clause in clauses] == ["CUSTOM-1"]
    assert clauses[0].title == "Custom clause"
    assert clauses[0].text == "Loaded from an overridden file."
    # The endpoint serves the overridden list too.
    body = client.get("/v1/moderation/policies").json()
    assert body == [{"id": "CUSTOM-1", "title": "Custom clause", "text": "Loaded from an overridden file."}]


def test_get_clauses_reload_after_file_change(tmp_path):
    target = tmp_path / "policies.yaml"
    target.write_text('clauses:\n  - id: "A"\n    title: A\n    text: first\n', encoding="utf-8")
    assert [clause.id for clause in get_clauses(target)] == ["A"]
    target.write_text(
        'clauses:\n  - id: "A"\n    title: A\n    text: first\n  - id: "B"\n    title: B\n    text: second\n',
        encoding="utf-8",
    )
    assert [clause.id for clause in get_clauses(target)] == ["A", "B"]


def test_missing_file_is_a_clear_error(tmp_path):
    with pytest.raises(PolicyClauseError, match="cannot read"):
        load_clauses(tmp_path / "absent.yaml")


def test_duplicate_ids_are_rejected(tmp_path):
    target = tmp_path / "policies.yaml"
    target.write_text(
        'clauses:\n'
        '  - id: "DUP"\n    title: First\n    text: one\n'
        '  - id: "DUP"\n    title: Second\n    text: two\n',
        encoding="utf-8",
    )
    with pytest.raises(PolicyClauseError, match="duplicate clause id"):
        load_clauses(target)


@pytest.mark.parametrize(
    "body, message",
    [
        ("clauses: 7", "'clauses' must be a list"),
        ("something_else: []", "missing 'clauses' list"),
        ("- id: \"A\"\n  title: only a title\n", "clause #1 is invalid"),
    ],
)
def test_invalid_documents_are_rejected(tmp_path, body, message):
    target = tmp_path / "policies.yaml"
    target.write_text(body, encoding="utf-8")
    with pytest.raises(PolicyClauseError, match=message):
        load_clauses(target)


def test_top_level_list_is_accepted(tmp_path):
    target = tmp_path / "policies.yaml"
    target.write_text('- id: "L1"\n  title: One\n  text: plain list\n', encoding="utf-8")
    clauses = load_clauses(target)
    assert [clause.model_dump() for clause in clauses] == [
        {"id": "L1", "title": "One", "text": "plain list"}
    ]


def test_yaml_subset_parser_quoting_comments_and_blocks():
    document = (
        "# leading comment\n"
        "clauses:\n"
        "  - id: \"Q-1\"   # trailing comment\n"
        "    title: 'It''s quoted'\n"
        "    text: |-\n"
        "      first line\n"
        "      second line\n"
        "\n"
        "  - id: Q-2\n"
        "    title: Plain title\n"
        "    text: >\n"
        "      folded\n"
        "      paragraph\n"
    )
    data = parse_yaml_subset(document)
    assert data == {
        "clauses": [
            {"id": "Q-1", "title": "It's quoted", "text": "first line\nsecond line"},
            {"id": "Q-2", "title": "Plain title", "text": "folded paragraph\n"},
        ]
    }


def test_yaml_subset_parser_bundled_and_scalar_lists():
    assert parse_yaml_subset("") is None
    assert parse_yaml_subset("# only a comment\n") is None
    assert parse_yaml_subset("- one\n- \"two three\"\n") == ["one", "two three"]
    assert parse_yaml_subset("key:\n  - a\n  - b\n") == {"key": ["a", "b"]}


def test_bundled_policies_path_is_inside_the_module():
    path = bundled_policies_path()
    assert path.name == "policies.yaml"
    assert path.parent.name == "moderation"
    assert path.is_file()
    assert PolicyClause.model_validate(get_clauses()[0].model_dump())
