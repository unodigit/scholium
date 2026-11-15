"""Errors raised by the advisory AI pre-review subsystem."""


class PrivateDraftError(Exception):
    """A hosted provider was asked to process an unlisted (private) draft.

    Spec constraint: unlisted drafts are processed only by self-hosted or
    fake AI providers, so hosted providers refuse them before any content
    leaves the node.  The message always begins with ``PrivateDraftError``
    so callers can surface it verbatim.
    """
