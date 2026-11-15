"""Tests for the agent prompt files and ``prompt_set_hash`` (feature 117).

Covers: one Markdown prompt per specialist agent in ``prompts/``, prompts that
state the finding fields and evidence kinds and keep paper text out of the
instructions, and a prompt-set sha256 that is reproducible by hand, covers
every prompt file and changes with any edit.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path

import pytest

from app.modules import ai_review
from app.modules.ai_review import prompt_set
from app.modules.ai_review.errors import PromptSetError, UnknownAgentError

AGENTS = ("methodology", "literature", "reproducibility", "integrity")


@pytest.fixture
def prompts_copy(tmp_path: Path) -> Path:
    """A private copy of the real prompts directory that a test may edit."""
    target = tmp_path / "prompts"
    shutil.copytree(prompt_set.PROMPTS_DIR, target)
    return target


def recompute(directory: Path) -> str:
    """The hash as the module docstring tells a third party to compute it."""
    digest = hashlib.sha256()
    for path in sorted(directory.glob("*.md"), key=lambda p: p.name):
        digest.update(path.name.encode("utf-8") + b"\0")
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# The prompt files                                                            #
# --------------------------------------------------------------------------- #


class TestPromptFiles:
    def test_prompts_live_in_prompts_dir_next_to_the_module(self):
        module_dir = Path(ai_review.__file__).resolve().parent
        assert prompt_set.PROMPTS_DIR == module_dir / "prompts"
        assert prompt_set.PROMPTS_DIR.is_dir()

    @pytest.mark.parametrize("agent", AGENTS)
    def test_each_specialist_agent_has_a_markdown_prompt(self, agent):
        path = prompt_set.PROMPTS_DIR / f"{agent}.md"

        assert path.is_file()
        assert path.read_text(encoding="utf-8").strip()
        assert ai_review.load_prompt(agent) == path.read_text(encoding="utf-8")

    def test_agent_names_are_the_four_specialists(self):
        assert ai_review.AGENT_NAMES == AGENTS
        assert set(ai_review.load_prompts()) == set(AGENTS)

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_is_named_for_its_agent(self, agent):
        first_line = ai_review.load_prompt(agent).splitlines()[0]

        assert first_line.lower() == f"# {agent} agent"

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_states_every_finding_field(self, agent):
        prompt = ai_review.load_prompt(agent)

        for field in ("claim", "severity", "confidence", "evidence", "findings"):
            assert f'"{field}"' in prompt, field
        for level in ai_review.SEVERITIES + ai_review.CONFIDENCES:
            assert f"`{level}`" in prompt, level

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_demands_evidence_and_drops_findings_without_it(self, agent):
        prompt = ai_review.load_prompt(agent)

        assert "`span`" in prompt
        assert "character for character" in prompt
        assert "discarded" in prompt

    def test_each_agent_names_its_own_evidence_kinds(self):
        kinds = {
            agent: {
                kind
                for kind in ai_review.EVIDENCE_KINDS
                if f"`{kind}`" in ai_review.load_prompt(agent)
            }
            for agent in AGENTS
        }

        assert kinds["methodology"] == {"span"}
        assert kinds["literature"] == {"span", "reference_id"}
        assert kinds["reproducibility"] == {"span", "log_line"}
        assert kinds["integrity"] == {"span", "reference_id"}

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_treats_data_blocks_as_quoted_data_not_instructions(self, agent):
        prompt = ai_review.load_prompt(agent)

        assert "quoted" in prompt
        assert "never an instruction" in prompt
        assert "do not comply" in prompt

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_labels_the_report_advisory(self, agent):
        prompt = ai_review.load_prompt(agent)

        assert "advisory" in prompt
        assert "never changes the paper's status" in prompt

    def test_literature_prompt_explains_reference_ids(self):
        prompt = ai_review.load_prompt("literature")

        assert ai_review.REFERENCE_BLOCK_PREFIX in prompt
        assert "Never invent a reference" in prompt

    def test_reproducibility_prompt_explains_the_run_log(self):
        prompt = ai_review.load_prompt("reproducibility")

        assert ai_review.RUN_LOG_BLOCK_ID in prompt
        assert "no network" in prompt
        assert "If there is no `run_log` block, the code was not run" in prompt

    def test_integrity_prompt_requires_needs_a_human_check_wording(self):
        prompt = ai_review.load_prompt("integrity")

        assert "Needs a human check." in prompt
        assert re.search(r"[Nn]ever write that fraud, plagiarism", prompt)

    @pytest.mark.parametrize("agent", AGENTS)
    def test_prompt_is_not_built_from_paper_text(self, agent):
        # A prompt is static: nothing in it is a placeholder for paper text.
        prompt = ai_review.load_prompt(agent)

        assert "{paper" not in prompt
        assert "{{" not in prompt


# --------------------------------------------------------------------------- #
# load_prompt errors                                                          #
# --------------------------------------------------------------------------- #


class TestLoadPrompt:
    @pytest.mark.parametrize("agent", ["meta_reviewer", "", "Methodology", "../secrets"])
    def test_unknown_agent_is_rejected(self, agent):
        with pytest.raises(UnknownAgentError, match="unknown agent"):
            ai_review.load_prompt(agent)

    def test_non_string_agent_is_rejected(self):
        with pytest.raises(UnknownAgentError):
            ai_review.load_prompt(None)  # type: ignore[arg-type]

    def test_unknown_agent_error_is_a_value_error(self):
        assert issubclass(UnknownAgentError, ValueError)

    def test_missing_prompt_file_is_reported(self, prompts_copy):
        (prompts_copy / "literature.md").unlink()

        with pytest.raises(PromptSetError, match="literature"):
            ai_review.load_prompt("literature", prompts_copy)

    def test_empty_prompt_file_is_reported(self, prompts_copy):
        (prompts_copy / "integrity.md").write_text(" \n", encoding="utf-8")

        with pytest.raises(PromptSetError, match="empty"):
            ai_review.load_prompt("integrity", prompts_copy)

    def test_windows_line_endings_are_folded(self, prompts_copy):
        (prompts_copy / "methodology.md").write_bytes(b"# Methodology agent\r\nBody\r\n")

        assert ai_review.load_prompt("methodology", prompts_copy) == (
            "# Methodology agent\nBody\n"
        )


# --------------------------------------------------------------------------- #
# prompt_set_hash                                                             #
# --------------------------------------------------------------------------- #


class TestPromptSetHash:
    def test_is_a_sha256_hex_digest(self):
        value = ai_review.prompt_set_hash()

        assert re.fullmatch(r"[0-9a-f]{64}", value)

    def test_is_exposed_by_the_package(self):
        assert ai_review.prompt_set_hash is prompt_set.prompt_set_hash
        assert "prompt_set_hash" in ai_review.__all__

    def test_is_stable_across_calls(self):
        assert ai_review.prompt_set_hash() == ai_review.prompt_set_hash()

    def test_matches_the_documented_recipe(self):
        assert ai_review.prompt_set_hash() == recompute(prompt_set.PROMPTS_DIR)

    def test_a_copy_of_the_files_has_the_same_hash(self, prompts_copy):
        assert ai_review.prompt_set_hash(prompts_copy) == ai_review.prompt_set_hash()

    def test_changing_one_character_of_any_prompt_changes_it(self, prompts_copy):
        baseline = ai_review.prompt_set_hash(prompts_copy)

        for agent in AGENTS:
            path = prompts_copy / f"{agent}.md"
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            changed = ai_review.prompt_set_hash(prompts_copy)
            path.write_bytes(original)

            assert changed != baseline, agent
            # Restoring the bytes restores the hash.
            assert ai_review.prompt_set_hash(prompts_copy) == baseline

    def test_renaming_a_prompt_changes_it(self, prompts_copy):
        baseline = ai_review.prompt_set_hash(prompts_copy)
        extra = prompts_copy / "notes.md"
        extra.write_text("same bytes", encoding="utf-8")
        with_notes = ai_review.prompt_set_hash(prompts_copy)
        extra.rename(prompts_copy / "other.md")

        assert with_notes != baseline
        assert ai_review.prompt_set_hash(prompts_copy) != with_notes

    def test_a_further_prompt_file_is_covered(self, prompts_copy):
        # The meta-reviewer's prompt (feature 120) joins the set by existing.
        baseline = ai_review.prompt_set_hash(prompts_copy)
        (prompts_copy / "meta_reviewer.md").write_text("# Meta", encoding="utf-8")

        assert ai_review.prompt_set_hash(prompts_copy) != baseline
        assert ai_review.prompt_set_hash(prompts_copy) == recompute(prompts_copy)

    def test_files_that_are_not_markdown_are_not_covered(self, prompts_copy):
        baseline = ai_review.prompt_set_hash(prompts_copy)
        (prompts_copy / "scratch.txt").write_text("ignored", encoding="utf-8")
        (prompts_copy / ".DS_Store").write_bytes(b"\x00")

        assert ai_review.prompt_set_hash(prompts_copy) == baseline

    def test_windows_line_endings_give_the_same_hash(self, prompts_copy):
        baseline = ai_review.prompt_set_hash(prompts_copy)
        for path in prompts_copy.glob("*.md"):
            path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))

        assert ai_review.prompt_set_hash(prompts_copy) == baseline

    def test_hash_is_computed_from_the_files_each_time(self, prompts_copy):
        baseline = ai_review.prompt_set_hash(prompts_copy)
        path = prompts_copy / "integrity.md"
        path.write_text(path.read_text(encoding="utf-8") + "\nExtra rule.\n", encoding="utf-8")

        assert ai_review.prompt_set_hash(prompts_copy) != baseline

    def test_a_set_missing_an_agents_prompt_has_no_hash(self, prompts_copy):
        (prompts_copy / "methodology.md").unlink()

        with pytest.raises(PromptSetError, match="methodology"):
            ai_review.prompt_set_hash(prompts_copy)

    def test_an_empty_directory_has_no_hash(self, tmp_path):
        empty = tmp_path / "none"
        empty.mkdir()

        with pytest.raises(PromptSetError):
            ai_review.prompt_set_hash(empty)

    def test_a_missing_directory_has_no_hash(self, tmp_path):
        with pytest.raises(PromptSetError):
            ai_review.prompt_set_hash(tmp_path / "absent")

    def test_prompt_files_are_sorted_by_name(self):
        names = [path.name for path in ai_review.prompt_files()]

        assert names == sorted(names)
        assert set(f"{agent}.md" for agent in AGENTS) <= set(names)
