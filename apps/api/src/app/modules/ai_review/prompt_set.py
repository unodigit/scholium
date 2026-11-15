"""The public agent prompts and their hash (feature 117).

Every agent's instructions live in a Markdown file in the ``prompts/``
directory next to this module, one per agent::

    prompts/methodology.md
    prompts/literature.md
    prompts/reproducibility.md
    prompts/integrity.md

The prompts are the trusted half of a request.  They never contain paper
text; the paper travels only as quoted data blocks (see
:mod:`app.modules.ai_review.agent_input`).  Changing a prompt changes
behaviour, so a signed ``ai.review`` record stores :func:`prompt_set_hash`,
and a third party holding the same files and model versions can re-run the
same configuration::

    from app.modules import ai_review

    ai_review.load_prompt("methodology")   # the agent's instructions
    ai_review.prompt_set_hash()            # 64 lowercase hex characters

The hash
    ``prompt_set_hash`` is the sha256 of every ``*.md`` file in ``prompts/``,
    not only the four specialist agents', so a later prompt (the
    meta-reviewer's) is covered the moment its file exists.  It can be
    recomputed without this code::

        h = hashlib.sha256()
        for path in sorted(prompts_dir.glob("*.md"), key=lambda p: p.name):
            h.update(path.name.encode("utf-8") + b"\\0")
            h.update(path.read_bytes().replace(b"\\r\\n", b"\\n"))
            h.update(b"\\0")
        h.hexdigest()

    File names are part of the digest, so renaming a prompt changes it.
    Windows line endings are folded to ``\\n`` so a checkout with
    ``core.autocrlf`` gives the same hash as the repository.  Nothing else is
    normalized: one changed character in any prompt changes the hash.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional, Union

from .errors import PromptSetError, UnknownAgentError

__all__ = [
    "AGENT_NAMES",
    "PROMPTS_DIR",
    "PROMPT_SUFFIX",
    "load_prompt",
    "load_prompts",
    "prompt_files",
    "prompt_set_hash",
]

#: The four specialist agents, in the order the pipeline lists them.
AGENT_NAMES: tuple[str, ...] = (
    "methodology",
    "literature",
    "reproducibility",
    "integrity",
)

#: Where the prompt files live.
PROMPTS_DIR: Path = Path(__file__).resolve().parent / "prompts"

#: Extension of a prompt file; the agent name is the file stem.
PROMPT_SUFFIX = ".md"


def _directory(directory: Optional[Union[str, Path]]) -> Path:
    return PROMPTS_DIR if directory is None else Path(directory)


def _read(path: Path) -> bytes:
    try:
        return path.read_bytes().replace(b"\r\n", b"\n")
    except OSError as exc:
        raise PromptSetError(f"cannot read prompt file {path}: {exc}") from exc


def prompt_files(directory: Optional[Union[str, Path]] = None) -> tuple[Path, ...]:
    """The prompt files of the set, sorted by file name.

    Raises:
        PromptSetError: if the directory holds no ``*.md`` file.
    """
    root = _directory(directory)
    files = tuple(
        sorted(
            (path for path in root.glob(f"*{PROMPT_SUFFIX}") if path.is_file()),
            key=lambda path: path.name,
        )
    )
    if not files:
        raise PromptSetError(f"no prompt files ({PROMPT_SUFFIX}) found in {root}")
    return files


def load_prompt(agent: str, directory: Optional[Union[str, Path]] = None) -> str:
    """The instructions of the specialist agent ``agent``.

    Args:
        agent: one of :data:`AGENT_NAMES`.
        directory: the prompt directory; defaults to :data:`PROMPTS_DIR`.

    Raises:
        UnknownAgentError: if ``agent`` is not one of :data:`AGENT_NAMES`.
        PromptSetError: if the agent's file is missing, unreadable or empty.
    """
    if not isinstance(agent, str) or agent not in AGENT_NAMES:
        expected = ", ".join(AGENT_NAMES)
        raise UnknownAgentError(f"unknown agent {agent!r}; expected one of: {expected}")
    path = _directory(directory) / f"{agent}{PROMPT_SUFFIX}"
    if not path.is_file():
        raise PromptSetError(f"prompt file for agent '{agent}' not found: {path}")
    text = _read(path).decode("utf-8")
    if not text.strip():
        raise PromptSetError(f"prompt file for agent '{agent}' is empty: {path}")
    return text


def load_prompts(
    directory: Optional[Union[str, Path]] = None,
) -> dict[str, str]:
    """Every specialist agent's instructions, keyed by agent name."""
    return {agent: load_prompt(agent, directory) for agent in AGENT_NAMES}


def prompt_set_hash(directory: Optional[Union[str, Path]] = None) -> str:
    """The sha256 (lowercase hex) of the whole prompt set.

    See the module docstring for the exact definition.  The hash is computed
    from the files on every call, so it always describes the prompts the
    agents would use now.

    Raises:
        PromptSetError: if a specialist agent's prompt is missing or empty, or
            a prompt file cannot be read.
    """
    # A set that lacks one of the four agents' prompts is not a usable
    # configuration, so refuse to give it a hash.
    load_prompts(directory)
    digest = hashlib.sha256()
    for path in prompt_files(directory):
        digest.update(path.name.encode("utf-8") + b"\0")
        digest.update(_read(path))
        digest.update(b"\0")
    return digest.hexdigest()
