"""Tests for the branded HTML notification email.

``build_email`` produces a ``multipart/alternative`` message: the plain-text
body that notifications have always carried, plus a table-based HTML
alternative.  These tests pin the structure (both parts exist), the brand
tokens, the links, the HTML-escaping of every user-supplied value, and that the
plain-text body did not change.  No test touches a network or the database.
"""

from __future__ import annotations

import email as email_lib
import re
from email import policy
from html.parser import HTMLParser

import pytest

from app.modules.notifications import Email, build_email
from app.modules.notifications.email_template import render_html, web_origin
from app.settings import settings

ORIGIN = "https://scholium.example"
LINK = "https://scholium.example/consent/bafyreiabc?round=2&utm=email"


@pytest.fixture(autouse=True)
def fixed_origin(monkeypatch):
    """Pin the web origin so assertions do not depend on the environment."""
    monkeypatch.setattr(settings, "WEB_ORIGINS", ORIGIN)


class Page(HTMLParser):
    """Collects the tags, attributes and visible text of an HTML document."""

    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str]]] = []
        self.text: list[str] = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, {k: v or "" for k, v in attrs}))

    def handle_data(self, data):
        self.text.append(data)

    def find(self, tag: str) -> list[dict[str, str]]:
        return [attrs for name, attrs in self.tags if name == tag]

    @property
    def visible(self) -> str:
        return " ".join(" ".join(self.text).split())


def _parts(email: Email):
    message = email.as_message()
    return message, message.get_body(("plain",)), message.get_body(("html",))


def _html(email: Email) -> str:
    return email.as_message().get_body(("html",)).get_content()


# --------------------------------------------------------------------------- #
# Structure
# --------------------------------------------------------------------------- #


def test_build_email_is_multipart_alternative_with_plain_then_html():
    email = build_email(
        "did:example:alice",
        "consent.request",
        {"email": "alice@example.org", "link": LINK},
    )
    message = email.as_message()

    assert message.get_content_type() == "multipart/alternative"
    parts = list(message.iter_parts())
    assert [part.get_content_type() for part in parts] == ["text/plain", "text/html"]
    assert all(part.get_content_charset() == "utf-8" for part in parts)
    # The HTML is also exposed on the Email itself.
    assert email.html == _html(email)


def test_headers_are_unchanged_by_the_html_alternative():
    email = build_email("did:example:alice", "digest", {"email": "alice@example.org"})
    message = email.as_message()

    assert message["To"] == "alice@example.org"
    assert message["From"] == email.from_addr
    assert message["Subject"] == "[Scholium] digest"


def test_both_parts_survive_the_smtp_wire_format():
    """``send_email`` ships ``as_string()``; a reader must still find both parts."""
    email = build_email(
        "did:example:alice",
        "consent.request",
        {"email": "alice@example.org", "link": LINK, "note": "Zoë’s paper — naïve"},
    )

    parsed = email_lib.message_from_string(email.as_message().as_string(), policy=policy.default)

    assert parsed.get_body(("plain",)).get_content() == email.body
    assert parsed.get_body(("html",)).get_content() == email.html
    assert "Zoë’s paper — naïve" in email.html


def test_email_without_html_stays_plain_text_only():
    """Emails built directly (the daily digest) keep their single plain part."""
    email = Email(
        to="alice@example.org",
        from_addr="noreply@scholium.local",
        subject="Digest",
        body="Two new papers.\n",
    )
    message = email.as_message()

    assert not message.is_multipart()
    assert message.get_content_type() == "text/plain"
    assert message.get_content() == "Two new papers.\n"


# --------------------------------------------------------------------------- #
# The plain-text body is unchanged
# --------------------------------------------------------------------------- #


def test_plain_text_body_is_exactly_the_existing_format():
    email = build_email(
        "did:example:alice",
        "consent.request",
        {
            "email": "alice@example.org",
            "paper_cid": "bafyreipaper",
            "n": 2,
            "link": LINK,
        },
    )
    expected = (
        "Notification for did:example:alice\n"
        "Kind: consent.request\n"
        "\n"
        "link: " + LINK + "\n"
        "n: 2\n"
        "paper_cid: bafyreipaper\n"
        "\n"
        "Open: " + LINK + "\n"
    )

    assert email.body == expected
    _, plain, _ = _parts(email)
    assert plain.get_content() == expected


def test_plain_text_body_for_non_mapping_and_empty_payloads_is_unchanged():
    assert build_email("did:example:alice", "digest").body == (
        "Notification for did:example:alice\nKind: digest\n"
    )
    assert build_email("did:example:alice", "note", "hello there").body == (
        "Notification for did:example:alice\nKind: note\n\nhello there\n"
    )


def test_plain_text_part_is_not_html_escaped_or_decorated():
    payload = {"title": "<b>Fish & Chips</b>", "link": LINK}
    email = build_email("did:example:alice", "note", payload)
    _, plain, _ = _parts(email)

    text = plain.get_content()
    assert "title: <b>Fish & Chips</b>" in text
    assert "&amp;" not in text
    assert "<table" not in text and "<html" not in text


# --------------------------------------------------------------------------- #
# Template: brand tokens and layout
# --------------------------------------------------------------------------- #


def test_template_is_a_table_layout_on_paper_with_a_white_card():
    html = _html(build_email("did:example:alice", "note", {"link": LINK}))
    page = Page(html)

    assert html.startswith("<!DOCTYPE html>")
    assert page.find("table"), "layout must be table based"
    assert "max-width:600px" in html
    assert any(t.get("width") == "600" for t in page.find("table"))
    assert "#FBFAF7" in html  # paper background
    assert "#FFFFFF" in html  # white card
    assert "#1B1D22" in html  # ink body text
    # The page background is on <body> and its wrapping table.
    body = next(attrs for tag, attrs in page.tags if tag == "body")
    assert "background-color:#FBFAF7" in body["style"]
    assert not page.find("script") and not page.find("link")


def test_header_is_one_lockup_image_on_the_paper_background():
    html = _html(build_email("did:example:alice", "note", {"link": LINK}))
    page = Page(html)

    (logo,) = page.find("img")
    assert logo["src"] == "https://scholium.example/brand/scholium-lockup-email.png"
    assert logo["alt"] == "Scholium"
    assert logo["width"] == "170" and logo["height"] == "32"
    assert logo["border"] == "0"
    assert "width:170px" in logo["style"] and "height:32px" in logo["style"]
    assert "display:block" in logo["style"] and "border:0" in logo["style"]

    assert "<svg" not in html.lower()
    # The header carries the wordmark as artwork, not as text, so no font
    # stack -- and in particular no serif one -- is left in it.
    header, _, _rest = html.partition('bgcolor="#FFFFFF"')
    assert "font-family" not in header
    assert not re.search(r"font-family\s*:[^;\"]*serif", header, re.IGNORECASE)
    assert "scholium" not in Page(header).visible.split()

    # It still sits on the paper background, above the white card.
    body = next(attrs for tag, attrs in page.tags if tag == "body")
    assert "background-color:#FBFAF7" in body["style"]
    assert "#FBFAF7" in header


def test_call_to_action_button_is_accent_blue_and_links_to_the_notification():
    html = _html(build_email("did:example:alice", "consent.request", {"link": LINK}))
    page = Page(html)

    cta = next(a for a in page.find("a") if "font-weight:600" in a.get("style", ""))
    # `&` in the URL is escaped for the attribute and parsed back to a real `&`.
    assert cta["href"] == LINK
    assert "href=\"" + LINK.replace("&", "&amp;") + "\"" in html
    assert "background-color:#2F4BA0" in html
    assert "color:#FFFFFF" in cta["style"]
    assert "Open in Scholium" in page.visible


def test_link_keys_follow_the_same_precedence_as_the_plain_text_open_line():
    payload = {"url": "https://scholium.example/second", "consent_link": "https://x.example/third"}
    email = build_email("did:example:alice", "note", payload)

    assert "Open: https://scholium.example/second" in email.body
    hrefs = [a["href"] for a in Page(email.html).find("a")]
    assert "https://scholium.example/second" in hrefs
    assert "https://x.example/third" not in hrefs


def test_footer_explains_why_and_links_to_notification_settings():
    email = build_email("did:example:alice", "note", {"link": LINK})
    page = Page(email.html)

    assert "You are receiving this email because a notification was addressed to your" in page.visible
    assert "did:example:alice" in page.visible
    assert "change which notifications you receive" in page.visible
    settings_links = [a["href"] for a in page.find("a") if a["href"].endswith("/me#notifications")]
    assert settings_links == ["https://scholium.example/me#notifications"]


# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #


def test_copyable_fallback_link_shows_the_full_url():
    page = Page(_html(build_email("did:example:alice", "note", {"link": LINK})))
    assert LINK in page.visible


def test_relative_link_is_resolved_against_the_web_origin():
    email = build_email("did:example:alice", "consent.request", {"link": "/consent/bafyreiabc"})
    hrefs = [a["href"] for a in Page(email.html).find("a")]

    assert "https://scholium.example/consent/bafyreiabc" in hrefs
    # The plain-text body keeps the link exactly as given.
    assert "Open: /consent/bafyreiabc" in email.body


@pytest.mark.parametrize(
    "link",
    [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "//evil.example/phish",
        "https://scholium.example/a b",
        "ftp://scholium.example/file",
        "not a url",
    ],
)
def test_unsafe_links_never_become_an_href_or_a_button(link):
    email = build_email("did:example:alice", "note", {"link": link})
    page = Page(email.html)

    assert "javascript:" not in email.html.lower()
    assert "Open in Scholium" not in page.visible
    assert link not in [a["href"] for a in page.find("a")]
    # The plain-text body is unchanged: it still shows what was given.
    assert f"Open: {link}" in email.body


def test_no_link_means_no_button():
    page = Page(build_email("did:example:alice", "digest", {"n": 1}).html)
    assert "Open in Scholium" not in page.visible
    assert [a["href"] for a in page.find("a")] == ["https://scholium.example/me#notifications"]


def test_origin_comes_from_the_first_usable_web_origin(monkeypatch):
    monkeypatch.setattr(settings, "WEB_ORIGINS", " , *, https://app.scholium.example/ ,http://other.example")
    assert web_origin() == "https://app.scholium.example"

    html = _html(build_email("did:example:alice", "note", {"link": LINK}))
    assert 'src="https://app.scholium.example/brand/scholium-lockup-email.png"' in html


def test_render_html_origin_override_beats_settings():
    html = render_html("did:example:alice", "note", {}, origin="http://localhost:3000/")
    assert 'src="http://localhost:3000/brand/scholium-lockup-email.png"' in html
    assert 'href="http://localhost:3000/me#notifications"' in html


def test_without_a_web_origin_the_footer_names_settings_without_a_dead_link(monkeypatch):
    monkeypatch.setattr(settings, "WEB_ORIGINS", "")
    assert web_origin() == ""

    page = Page(build_email("did:example:alice", "note", {"link": "/consent/x"}).html)
    assert "notification settings" in page.visible
    assert page.find("a") == []  # relative link cannot be followed from an inbox


# --------------------------------------------------------------------------- #
# Escaping
# --------------------------------------------------------------------------- #

SCRIPT = "<script>alert('xss')</script>"
BREAKOUT = '"><img src=x onerror=alert(1)>'


def test_all_user_supplied_text_is_html_escaped():
    did = f"did:example:<b>alice</b>{BREAKOUT}"
    kind = f"note.<i>{SCRIPT}"
    payload = {
        "email": "alice@example.org",
        f"key<u>{SCRIPT}": f"value {SCRIPT} & {BREAKOUT}",
        "title": "Fish & Chips <3",
        "link": 'https://scholium.example/p?a=1&b="2"<x>',
    }
    email = build_email(did, kind, payload)
    html = email.html
    page = Page(html)

    # Nothing user-supplied can open a tag or an attribute.
    assert "<script" not in html
    assert "<b>" not in html and "<i>" not in html and "<u>" not in html
    assert "onerror=alert(1)>" not in html
    # The injected text survives only as inert escaped text, never as markup:
    # no stray tags and no event-handler attribute anywhere.
    assert [tag for tag, _ in page.tags if tag in {"script", "b", "i", "u"}] == []
    assert not any(name.startswith("on") for _, attrs in page.tags for name in attrs)
    assert len(page.find("img")) == 1  # only the logo

    # ...and it all still reads correctly once a mail client renders it.
    assert f"value {SCRIPT} & {BREAKOUT}" in page.visible
    assert "Fish & Chips <3" in page.visible
    assert f"key<u>{SCRIPT}" in page.visible
    assert did in page.visible
    assert f"Note <i>{SCRIPT}" in page.visible  # heading: kind with "." read as a space

    # The escaped forms are what is in the markup.
    assert "Fish &amp; Chips &lt;3" in html
    assert "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;" in html
    assert "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;" in html

    # The plain-text body is raw text, not HTML.
    assert "title: Fish & Chips <3" in email.body


def test_escaped_link_cannot_break_out_of_the_href_attribute():
    link = 'https://scholium.example/p?x="onmouseover="alert(1)'
    email = build_email("did:example:alice", "note", {"link": link})
    page = Page(email.html)

    anchors = [a for a in page.find("a") if a["href"].startswith("https://scholium.example/p")]
    assert anchors, "an http(s) link with quotes is still a link"
    for anchor in anchors:
        assert anchor["href"] == link
        assert "onmouseover" not in anchor
    assert 'href="https://scholium.example/p?x="' not in email.html
    assert "&quot;onmouseover=&quot;alert(1)" in email.html


def test_non_string_payload_values_are_stringified_and_escaped():
    payload = {"count": 3, "ids": ["<a>", "b&c"], "nested": {"k": "<v>"}, "none": None}
    page = Page(build_email("did:example:alice", "note", payload).html)

    assert "count 3" in page.visible
    assert "['<a>', 'b&c']" in page.visible
    assert "{'k': '<v>'}" in page.visible
    assert "none None" in page.visible
    assert not page.find("a") or all("<" not in a["href"] for a in page.find("a"))


def test_scalar_payload_is_shown_escaped():
    html = build_email("did:example:alice", "note", "<b>hi</b> & bye").html
    assert "&lt;b&gt;hi&lt;/b&gt; &amp; bye" in html
    assert "<b>hi</b>" not in html


def test_recipient_address_and_link_are_not_listed_as_details():
    page = Page(
        build_email(
            "did:example:alice",
            "note",
            {"email": "secret@example.org", "to": "t@example.org", "link": LINK, "paper": "p1"},
        ).html
    )

    assert "secret@example.org" not in page.visible
    assert "t@example.org" not in page.visible
    assert "paper p1" in page.visible
    # The link is shown once as the button's copy-paste fallback, not as a detail row.
    assert page.visible.count(LINK) == 1


def test_kind_heading_is_human_readable():
    page = Page(build_email("did:example:alice", "consent.request", {}).html)
    assert "Consent request" in page.visible
    assert render_html("did:example:alice", "", {}).count("<h1") == 1
    assert ">Notification</h1>" in render_html("did:example:alice", "", {})
