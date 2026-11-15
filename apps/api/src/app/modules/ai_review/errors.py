"""Errors raised by the advisory AI pre-review subsystem."""


class PrivateDraftError(Exception):
    """A hosted provider was asked to process an unlisted (private) draft.

    Spec constraint: unlisted drafts are processed only by self-hosted or
    fake AI providers, so hosted providers refuse them before any content
    leaves the node.  The message always begins with ``PrivateDraftError``
    so callers can surface it verbatim.
    """


class UnknownAgentError(ValueError):
    """An agent name other than methodology, literature, reproducibility or integrity."""


class PromptSetError(Exception):
    """The ``prompts/*.md`` files are missing, empty or unreadable.

    Raised instead of hashing or running with a partial prompt set: a
    ``prompt_set_hash`` that silently covers fewer prompts than the agents
    use would let a signed report claim a configuration nobody can re-run.
    """


class BundleError(ValueError):
    """A code bundle cannot be unpacked for the sandbox (feature 119).

    ``reason`` is the ``not_run`` reason it becomes
    (``bundle_unavailable`` or ``bundle_rejected``) and ``detail`` a short,
    host-independent sentence safe to show readers.  Raised inside the
    reproducibility agent and turned into a ``not_run`` finding; it does not
    reach the caller of :func:`~app.modules.ai_review.run_reproducibility_agent`.
    """

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


class AgentOutputError(ValueError):
    """An agent's reply holds no JSON object with a ``findings`` list.

    Individual malformed findings do not raise this; they are dropped and
    reported in :attr:`~app.modules.ai_review.agents.AgentReport.dropped`.
    """
