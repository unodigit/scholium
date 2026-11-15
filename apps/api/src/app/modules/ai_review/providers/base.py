"""LLM provider interface for the advisory AI pre-review pipeline.

Paper text reaches a provider as quoted :class:`DataBlock` items carried in
a separate channel of :class:`LLMRequest`; it is never concatenated into
``instructions``.  Providers whose ``hosted`` flag is true send content to
a third party, so :meth:`LLMProvider.complete` refuses unlisted drafts
before any implementation code runs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar

from ..errors import PrivateDraftError


@dataclass(frozen=True)
class DataBlock:
    """A separately quoted chunk of paper data passed to the model.

    ``id`` is the stable identifier of the quoted unit (for example a
    paragraph id such as ``p12``); ``content`` is the verbatim text.
    """

    id: str
    content: str


@dataclass(frozen=True)
class LLMRequest:
    """One call to a provider: instructions plus quoted data blocks.

    ``listed`` records whether the draft being processed is listed (public).
    It fails closed: only requests explicitly marked ``listed=True`` may be
    sent to a hosted provider.
    """

    instructions: str
    data_blocks: tuple[DataBlock, ...] = ()
    listed: bool = False
    max_tokens: int = 2048


@dataclass(frozen=True)
class LLMResponse:
    """A provider completion, echo'ing the provider and model used."""

    text: str
    provider: str
    model: str


class LLMProvider(ABC):
    """Interface every AI pre-review provider implements.

    Class attributes:

    ``name``
        Provider identifier used by ``AI_PROVIDER`` selection.
    ``hosted``
        True when content leaves the node (third-party API).  Hosted
        providers may only process listed (public) papers.
    """

    name: ClassVar[str] = ""
    hosted: ClassVar[bool] = False
    model: str = ""

    def check_listed(self, listed: bool) -> None:
        """Refuse an unlisted draft when this provider is hosted.

        Raises:
            PrivateDraftError: if the provider is hosted and ``listed`` is false.

        Callers that do slow work before they reach :meth:`complete` (the
        reproducibility agent runs a sandbox first) call this up front so a
        refusal does not come after the work.
        """
        if self.hosted and not listed:
            raise PrivateDraftError(
                "PrivateDraftError: hosted provider "
                f"'{self.name}' cannot process an unlisted draft; unlisted "
                "drafts may only be processed by self-hosted or fake providers"
            )

    def complete(self, request: LLMRequest) -> LLMResponse:
        """Process ``request``, refusing unlisted drafts on hosted providers.

        The guard lives here rather than in each hosted implementation so no
        provider can forget it: unlisted drafts raise
        :class:`~app.modules.ai_review.errors.PrivateDraftError` before any
        network call is made.
        """
        self.check_listed(request.listed)
        return self._complete(request)

    @abstractmethod
    def _complete(self, request: LLMRequest) -> LLMResponse:
        """Provider-specific implementation; runs only for allowed requests."""
