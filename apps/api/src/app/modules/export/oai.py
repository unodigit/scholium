"""``GET /v1/oai`` -- an OAI-PMH 2.0 interface (plugin: export, feature 94).

The module loader mounts this package's ``router`` under ``/v1``, so a
harvester calls::

    GET /v1/oai?verb=ListRecords

and receives OAI-PMH 2.0 XML in which every record is one *listed* paper,
described in Dublin Core (``oai_dc``)::

    <?xml version="1.0" encoding="UTF-8"?>
    <OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
             xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
             xmlns:dc="http://purl.org/dc/elements/1.1/" ...>
      <responseDate>2026-11-15T12:00:00Z</responseDate>
      <request verb="ListRecords">http://localhost:8000/v1/oai</request>
      <ListRecords>
        <record>
          <header>
            <identifier>oai:scholium:sch:xxxx-xxxx-xxxx</identifier>
            <datestamp>2026-11-15T12:00:00Z</datestamp>
          </header>
          <metadata>
            <oai_dc:dc ...>
              <dc:title>...</dc:title>
              <dc:creator>did:key:z6Mk...</dc:creator>
              <dc:subject>cs.CR</dc:subject>
              <dc:description>...</dc:description>
              <dc:identifier>sch:xxxx-xxxx-xxxx</dc:identifier>
              ...
            </oai_dc:dc>
          </metadata>
        </record>
      </ListRecords>
    </OAI-PMH>

What is disseminated
--------------------
Only listed papers, one record each, described by the paper's latest listed
version -- the same choice ``GET /v1/papers/{id}`` makes.  See
:mod:`app.modules.export.records`; harvesting can never surface a draft,
version in consent, or version held by moderation.

The Dublin Core fields map from the signed metadata:

======================  ==========================================
``dc:title``            the version's title
``dc:creator``          each author's DID, in byline order
``dc:subject``          each category
``dc:description``      the version's abstract
``dc:publisher``        ``Scholium``
``dc:date``             the version's listing date
``dc:type``             ``Text``, then the paper's status
``dc:identifier``       the ``sch:`` id and version id
``dc:relation``         each notice (``retraction: ...``), if any
``dc:rights``           the version's licence
======================  ==========================================

Protocol behaviour
------------------
All six OAI-PMH verbs are served: ``Identify``, ``ListMetadataFormats``,
``ListSets``, ``GetRecord``, ``ListIdentifiers`` and ``ListRecords``.

* ``oai_dc`` is the only metadata format; any other ``metadataPrefix`` answers
  ``cannotDisseminateFormat``.  ``ListRecords`` and ``ListIdentifiers`` default
  to it when the argument is omitted, because the feature line spells the URL
  as plain ``?verb=ListRecords``; a harvester that sends ``metadataPrefix``
  gets the same records.
* There are no sets, so ``ListSets`` answers ``noSetHierarchy`` and any
  ``set`` argument is refused the same way.
* ``from``/``until`` accept either OAI date granularity
  (``YYYY-MM-DD`` or ``YYYY-MM-DDThh:mm:ssZ``) and filter on the record's
  listed datestamp, inclusively.
* A list too long for one response is paginated with an opaque
  ``resumptionToken``; using it with any other argument answers
  ``badArgument``.
* Protocol errors are returned as XML with HTTP ``200``, as OAI-PMH requires:
  ``badVerb``, ``badArgument``, ``badResumptionToken``,
  ``cannotDisseminateFormat``, ``idDoesNotExist``, ``noRecordsMatch`` and
  ``noSetHierarchy`` are all produced here.

Everything is public: like reading a record or a paper, harvesting needs no
token.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from typing import Optional
from xml.etree import ElementTree as ET

from fastapi import APIRouter, Request, Response

from .records import EPOCH, ListedPaper, find_listed, listed_papers

__all__ = [
    "ADMIN_EMAIL",
    "DC_NAMESPACE",
    "GRANULARITY",
    "METADATA_PREFIX",
    "OAI_DC_NAMESPACE",
    "OAI_NAMESPACE",
    "PAGE_SIZE",
    "REPOSITORY_NAME",
    "VERBS",
    "ProtocolError",
    "router",
]

#: The OAI-PMH 2.0 namespace, the metadata container, and Dublin Core.
OAI_NAMESPACE = "http://www.openarchives.org/OAI/2.0/"
OAI_DC_NAMESPACE = "http://www.openarchives.org/OAI/2.0/oai_dc/"
DC_NAMESPACE = "http://purl.org/dc/elements/1.1/"
XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"

#: The only metadata format this repository disseminates.  The schema URL is
#: OAI-PMH's conventional location for the Dublin Core container.
METADATA_PREFIX = "oai_dc"
METADATA_FORMAT_SCHEMA = "http://www.openarchives.org/OAI/2.0/oai_dc.xsd"
METADATA_FORMAT_NAMESPACE = DC_NAMESPACE

REPOSITORY_NAME = "Scholium"
PROTOCOL_VERSION = "2.0"
GRANULARITY = "YYYY-MM-DDThh:mm:ssZ"
#: This repository never disseminates deleted-record headers.
DELETED_RECORD = "no"

#: Where a harvester should write about problems.  Overridable so a deployment
#: names its own operator without this module growing a settings dependency.
ADMIN_EMAIL = os.getenv("OAI_ADMIN_EMAIL", "admin@scholium.local")

#: Records per response page; longer harvests continue with a resumption token.
PAGE_SIZE = 100

VERBS = (
    "Identify",
    "ListMetadataFormats",
    "ListSets",
    "GetRecord",
    "ListIdentifiers",
    "ListRecords",
)

#: Arguments OAI-PMH defines.  Anything else is ``badArgument``.
ARGUMENTS = ("verb", "identifier", "metadataPrefix", "from", "until", "set", "resumptionToken")

#: Arguments echoed as attributes of the response's ``request`` element.
_ECHOED = ("identifier", "metadataPrefix", "from", "until", "set", "resumptionToken")

# ElementTree keeps one namespace-prefix registry per process.  These names are
# the conventional OAI-PMH/schema prefixes; ``imports.arxiv`` only *parses*
# XML, so nothing else in the application serialises with them.
ET.register_namespace("", OAI_NAMESPACE)
ET.register_namespace("oai_dc", OAI_DC_NAMESPACE)
ET.register_namespace("dc", DC_NAMESPACE)
ET.register_namespace("xsi", XSI_NAMESPACE)

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["oai"])


class ProtocolError(Exception):
    """An OAI-PMH error, rendered as ``<error code="...">`` in the response."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        verb: Optional[str] = None,
        arguments: Optional[dict[str, str]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        #: The verb to echo in ``request``; ``None`` for ``badVerb``, whose
        #: request element must carry no attributes at all.
        self.verb = verb
        self.arguments = arguments or {}


# --------------------------------------------------------------------------- #
# Small XML helpers
# --------------------------------------------------------------------------- #


def _q(name: str) -> str:
    """``name`` in the OAI-PMH namespace."""
    return f"{{{OAI_NAMESPACE}}}{name}"


def _dublin_core(name: str) -> str:
    return f"{{{DC_NAMESPACE}}}{name}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _datestamp(moment: datetime) -> str:
    """OAI-PMH's ``YYYY-MM-DDThh:mm:ssZ`` form, in UTC."""
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(moment: datetime) -> str:
    """The ``YYYY-MM-DD`` Dublin Core form of ``moment``."""
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%d")


def _base_url(request: Request) -> str:
    """The repository's base URL: the request URL without its arguments."""
    return str(request.url).split("?", 1)[0]


def _sub(parent: ET.Element, tag: str, text: Optional[str] = None) -> ET.Element:
    element = ET.SubElement(parent, tag)
    if text is not None:
        element.text = text
    return element


def _request_element(
    parent: ET.Element,
    request: Request,
    *,
    verb: Optional[str],
    arguments: dict[str, str],
) -> None:
    attributes = {name: arguments[name] for name in _ECHOED if name in arguments}
    if verb is not None:
        attributes = {"verb": verb, **attributes}
    _sub(parent, _q("request"), _base_url(request)).attrib.update(attributes)


def _document(
    request: Request,
    *,
    verb: Optional[str],
    arguments: dict[str, str],
    body: ET.Element,
) -> bytes:
    """Wrap ``body`` in the OAI-PMH envelope and serialise it."""
    root = ET.Element(
        _q("OAI-PMH"),
        {
            f"{{{XSI_NAMESPACE}}}schemaLocation": (
                f"{OAI_NAMESPACE} {OAI_NAMESPACE}OAI-PMH.xsd"
            )
        },
    )
    _sub(root, _q("responseDate"), _datestamp(_utcnow()))
    _request_element(root, request, verb=verb, arguments=arguments)
    root.append(body)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _error_document(request: Request, error: ProtocolError) -> bytes:
    element = ET.Element(_q("error"), {"code": error.code})
    element.text = error.message
    return _document(
        request, verb=error.verb, arguments=error.arguments, body=element
    )


def _response(xml: bytes) -> Response:
    # OAI-PMH 2.0 specifies ``text/xml``; Starlette appends the charset.
    return Response(content=xml, media_type="text/xml")


# --------------------------------------------------------------------------- #
# Dublin Core metadata
# --------------------------------------------------------------------------- #


def _metadata(parent: ET.Element, record: ListedPaper) -> None:
    """Append ``<metadata><oai_dc:dc>`` for one paper."""
    metadata = _sub(parent, _q("metadata"))
    dc = ET.SubElement(
        metadata,
        f"{{{OAI_DC_NAMESPACE}}}dc",
        {
            f"{{{XSI_NAMESPACE}}}schemaLocation": (
                f"{OAI_DC_NAMESPACE} {METADATA_FORMAT_SCHEMA}"
            )
        },
    )

    _sub(dc, _dublin_core("title"), record.version.title)
    for author in record.authors:
        _sub(dc, _dublin_core("creator"), author)
    for category in record.paper.categories or []:
        _sub(dc, _dublin_core("subject"), str(category))
    _sub(dc, _dublin_core("description"), record.version.abstract)
    _sub(dc, _dublin_core("publisher"), REPOSITORY_NAME)
    _sub(dc, _dublin_core("date"), _day(record.datestamp))
    # DCMI's type vocabulary value first, then the paper's scholarly status.
    _sub(dc, _dublin_core("type"), "Text")
    _sub(dc, _dublin_core("type"), record.paper.status or "preprint")
    _sub(dc, _dublin_core("identifier"), record.short_id)
    _sub(dc, _dublin_core("identifier"), record.version_id)
    for notice in record.notices:
        _sub(dc, _dublin_core("relation"), f"{notice.kind}: {notice.reason}")
    _sub(dc, _dublin_core("rights"), record.version.licence)


def _record(parent: ET.Element, record: ListedPaper) -> None:
    element = _sub(parent, _q("record"))
    _header(element, record)
    _metadata(element, record)


def _header(parent: ET.Element, record: ListedPaper) -> None:
    header = _sub(parent, _q("header"))
    _sub(header, _q("identifier"), record.identifier)
    _sub(header, _q("datestamp"), _datestamp(record.datestamp))


# --------------------------------------------------------------------------- #
# Verbs
# --------------------------------------------------------------------------- #


def _identify(element: ET.Element, request: Request) -> None:
    records = listed_papers()
    earliest = min((record.datestamp for record in records), default=EPOCH)
    _sub(element, _q("repositoryName"), REPOSITORY_NAME)
    _sub(element, _q("baseURL"), _base_url(request))
    _sub(element, _q("protocolVersion"), PROTOCOL_VERSION)
    _sub(element, _q("adminEmail"), ADMIN_EMAIL)
    _sub(element, _q("earliestDatestamp"), _datestamp(earliest))
    _sub(element, _q("deletedRecord"), DELETED_RECORD)
    _sub(element, _q("granularity"), GRANULARITY)


def _list_metadata_formats(element: ET.Element, arguments: dict[str, str]) -> None:
    identifier = arguments.get("identifier")
    if identifier is not None and find_listed(identifier) is None:
        raise ProtocolError(
            "idDoesNotExist",
            f"No listed paper {identifier!r} is on this node.",
            verb="ListMetadataFormats",
            arguments=arguments,
        )
    format_element = _sub(element, _q("metadataFormat"))
    _sub(format_element, _q("metadataPrefix"), METADATA_PREFIX)
    _sub(format_element, _q("schema"), METADATA_FORMAT_SCHEMA)
    _sub(format_element, _q("metadataNamespace"), METADATA_FORMAT_NAMESPACE)


def _get_record(element: ET.Element, arguments: dict[str, str]) -> None:
    identifier = (arguments.get("identifier") or "").strip()
    if not identifier:
        raise ProtocolError(
            "badArgument",
            "GetRecord requires an identifier argument.",
            verb="GetRecord",
            arguments=arguments,
        )
    _require_supported_prefix(arguments, "GetRecord")
    found = find_listed(identifier)
    if found is None:
        raise ProtocolError(
            "idDoesNotExist",
            f"No listed paper {identifier!r} is on this node.",
            verb="GetRecord",
            arguments=arguments,
        )
    _record(element, found)


def _require_supported_prefix(arguments: dict[str, str], verb: str) -> None:
    prefix = arguments.get("metadataPrefix")
    if prefix is not None and prefix != METADATA_PREFIX:
        raise ProtocolError(
            "cannotDisseminateFormat",
            f"This repository disseminates {METADATA_PREFIX!r} only.",
            verb=verb,
            arguments=arguments,
        )


def _list_identifiers(element: ET.Element, arguments: dict[str, str], verb: str) -> None:
    page = _page(arguments, verb)
    for record in page.records:
        _header(element, record)
    _resumption_token(element, page)


def _list_records(element: ET.Element, arguments: dict[str, str], verb: str) -> None:
    page = _page(arguments, verb)
    for record in page.records:
        _record(element, record)
    _resumption_token(element, page)


# --------------------------------------------------------------------------- #
# Listing: filtering, paging and resumption tokens
# --------------------------------------------------------------------------- #


class _Page:
    """The records of one list response and the token that continues it."""

    def __init__(
        self,
        records: list[ListedPaper],
        *,
        cursor: int,
        total: int,
        token: Optional[str],
    ) -> None:
        self.records = records
        self.cursor = cursor
        self.total = total
        self.token = token


def _parse_moment(value: str, name: str, *, end_of_day: bool) -> datetime:
    """Parse an OAI ``from``/``until`` argument (``ValueError`` when malformed)."""
    text = value.strip()
    if len(text) == 10:
        moment = datetime.strptime(text, "%Y-%m-%d")
        if end_of_day:
            # ``until=2026-11-15`` includes all of that day, as OAI-PMH day
            # granularity means.
            moment = moment.replace(hour=23, minute=59, second=59)
        return moment
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")


def _window(arguments: dict[str, str], verb: str) -> tuple[Optional[datetime], Optional[datetime]]:
    """The inclusive ``(from, until)`` datestamp window, or ``(None, None)``."""
    raw_from = arguments.get("from")
    raw_until = arguments.get("until")
    try:
        moment_from = (
            _parse_moment(raw_from, "from", end_of_day=False)
            if raw_from is not None
            else None
        )
        moment_until = (
            _parse_moment(raw_until, "until", end_of_day=True)
            if raw_until is not None
            else None
        )
    except ValueError as exc:
        raise ProtocolError(
            "badArgument",
            "from and until must be YYYY-MM-DD or YYYY-MM-DDThh:mm:ssZ.",
            verb=verb,
            arguments=arguments,
        ) from exc
    if moment_from is not None and moment_until is not None and moment_from > moment_until:
        raise ProtocolError(
            "badArgument",
            "from must not be later than until.",
            verb=verb,
            arguments=arguments,
        )
    return moment_from, moment_until


def _encode_token(verb: str, arguments: dict[str, str], cursor: int) -> str:
    payload: dict[str, object] = {"v": 1, "verb": verb, "cursor": cursor}
    for name in ("metadataPrefix", "from", "until", "set"):
        if name in arguments:
            payload[name] = arguments[name]
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_token(token: str, verb: str) -> tuple[dict[str, str], int]:
    """Return the arguments and cursor a resumption token carries."""
    try:
        padded = token + "=" * (-len(token) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        if not isinstance(payload, dict) or payload.get("v") != 1:
            raise ValueError("unknown token version")
        if payload.get("verb") != verb:
            raise ValueError("token belongs to another verb")
        cursor = payload.get("cursor")
        if not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 0:
            raise ValueError("bad cursor")
        arguments = {
            name: str(payload[name])
            for name in ("metadataPrefix", "from", "until", "set")
            if name in payload
        }
        return arguments, cursor
    except (ValueError, TypeError) as exc:
        raise ProtocolError(
            "badResumptionToken",
            "The resumption token is not valid for this verb.",
            verb=verb,
        ) from exc


def _page(arguments: dict[str, str], verb: str) -> _Page:
    """The response page for a list verb and the state a client continues from."""
    token = arguments.get("resumptionToken")
    if token is not None:
        # OAI-PMH makes the resumption token an exclusive argument.
        if any(
            name in arguments
            for name in ("identifier", "metadataPrefix", "from", "until", "set")
        ):
            raise ProtocolError(
                "badArgument",
                "resumptionToken is an exclusive argument.",
                verb=verb,
                arguments=arguments,
            )
        stored, cursor = _decode_token(token, verb)
        if stored.get("metadataPrefix", METADATA_PREFIX) != METADATA_PREFIX:
            raise ProtocolError(
                "cannotDisseminateFormat",
                f"This repository disseminates {METADATA_PREFIX!r} only.",
                verb=verb,
            )
        arguments = {"verb": verb, **stored, "resumptionToken": token}
        verb_arguments = stored
    else:
        _require_supported_prefix(arguments, verb)
        if "set" in arguments:
            raise ProtocolError(
                "noSetHierarchy",
                "This repository does not support sets.",
                verb=verb,
                arguments=arguments,
            )
        verb_arguments = arguments
        cursor = 0

    moment_from, moment_until = _window(verb_arguments, verb)
    records = listed_papers()
    if moment_from is not None:
        records = [record for record in records if record.datestamp >= moment_from]
    if moment_until is not None:
        records = [record for record in records if record.datestamp <= moment_until]

    total = len(records)
    if cursor == 0 and not records:
        raise ProtocolError(
            "noRecordsMatch",
            "No listed paper matches this request.",
            verb=verb,
            arguments=arguments,
        )
    if cursor >= total:
        raise ProtocolError(
            "badResumptionToken",
            "The resumption token is no longer valid.",
            verb=verb,
            arguments=arguments,
        )

    page = records[cursor : cursor + PAGE_SIZE]
    next_cursor = cursor + len(page)
    next_token = (
        _encode_token(verb, verb_arguments, next_cursor) if next_cursor < total else None
    )
    return _Page(page, cursor=cursor, total=total, token=next_token)


def _resumption_token(parent: ET.Element, page: _Page) -> None:
    """Append a ``resumptionToken`` carrying the cursor for the next page."""
    if page.token is None:
        return
    element = ET.SubElement(
        parent,
        _q("resumptionToken"),
        {"completeListSize": str(page.total), "cursor": str(page.cursor)},
    )
    element.text = page.token


# --------------------------------------------------------------------------- #
# The route
# --------------------------------------------------------------------------- #


def _verb_body(
    request: Request, verb: str, arguments: dict[str, str]
) -> ET.Element:
    """Build the verb-specific element, raising :class:`ProtocolError`."""
    if verb == "ListSets":
        raise ProtocolError(
            "noSetHierarchy",
            "This repository does not support sets.",
            verb=verb,
            arguments=arguments,
        )
    element = ET.Element(_q(verb))
    if verb == "Identify":
        _identify(element, request)
    elif verb == "ListMetadataFormats":
        _list_metadata_formats(element, arguments)
    elif verb == "GetRecord":
        _get_record(element, arguments)
    elif verb == "ListIdentifiers":
        _list_identifiers(element, arguments, verb)
    else:  # ListRecords -- the only verb left in VERBS
        _list_records(element, arguments, verb)
    return element


@router.get(
    "/oai",
    response_class=Response,
    summary="OAI-PMH 2.0 interface (Dublin Core records for listed papers)",
)
def oai(request: Request) -> Response:
    """Answer one OAI-PMH request, including its error responses."""
    arguments = dict(request.query_params)
    verb = arguments.get("verb")

    try:
        # Verb first: a request without a legal verb is badVerb whatever else
        # it carries, and its request element echoes no arguments.
        if not verb:
            raise ProtocolError("badVerb", "The verb argument is required.")
        if verb not in VERBS:
            raise ProtocolError("badVerb", f"Illegal verb {verb!r}.")

        for name in arguments:
            if name not in ARGUMENTS:
                raise ProtocolError(
                    "badArgument",
                    f"Unknown argument {name!r}.",
                    verb=verb,
                    arguments=arguments,
                )
            if len(request.query_params.getlist(name)) > 1:
                raise ProtocolError(
                    "badArgument",
                    f"Argument {name!r} must not be repeated.",
                    verb=verb,
                    arguments=arguments,
                )
        body = _verb_body(request, verb, arguments)
    except ProtocolError as error:
        if error.verb is None and error.code != "badVerb":
            # An error raised deep in the listing still echoes the request.
            error.verb = verb if verb in VERBS else None
            error.arguments = arguments if verb in VERBS else {}
        return _response(_error_document(request, error))

    return _response(
        _document(request, verb=verb, arguments=arguments, body=body)
    )
