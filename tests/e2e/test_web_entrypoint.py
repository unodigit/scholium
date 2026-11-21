"""The web app as shipped: ``next build`` then ``next start``, in front of a real node.

The browser journeys (``npm run test:e2e``, Playwright) drive a browser through
this same build; this file is the part that needs no browser: the production
build must succeed, the server must start, every response must carry the
security headers, and pages that are rendered on the server must show what the
API holds.  ``NEXT_PUBLIC_API_URL`` is baked into the bundle and the CSP at build
time, so the node's address is chosen before the build and the node started on
it afterwards.

The lockup (the BrandMark glyph and the outlined Scholium Display wordmark) is
checked on every surface that shows it, against the brand source
(``docs/brand``) and not against the app's own copy of it: the server-rendered
pages, the stylesheet, the two share cards, the lockup PNGs under
``/brand/`` and the header of a notification e-mail that the API sends and that
loads its image from this web server.

Needs ``npm install`` to have been run and takes about a minute (the build).
Select with ``-m web``; exclude with ``-m "not web"``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from html.parser import HTMLParser
from urllib.parse import quote, urljoin

import httpx
import pytest

from e2e_harness import REPO_ROOT, WEB_DIR, Process, clean_env, free_port, publish_listed_paper
from png_tools import decode_png, ink_box, ink_overlap, png_size

pytestmark = pytest.mark.web

# npm workspaces hoist the binaries to the repository root.
NEXT_BINARIES = [WEB_DIR / "node_modules" / ".bin" / "next", WEB_DIR.parent.parent / "node_modules" / ".bin" / "next"]


@pytest.fixture(scope="module")
def web(nodes):
    """(web base URL, node, node client, published paper): API and web app both started by their commands."""
    assert shutil.which("npm") and any(path.exists() for path in NEXT_BINARIES), (
        "apps/web is not installed: run `npm install` at the repository root "
        "(or leave these tests out with -m 'not web')"
    )
    node = nodes.make("webnode", storage="fs", jobs="thread")
    port = free_port()
    # The browser reaches the API on the same loopback name the CSP will list.
    api_origin = node.base_url
    # WEB_ORIGINS lets the page call the API cross-origin, as in a deployment.
    web_origin = f"http://127.0.0.1:{port}"
    node.env["WEB_ORIGINS"] = web_origin

    build = subprocess.run(
        ["npm", "run", "build"], cwd=WEB_DIR, capture_output=True, text=True, timeout=600,
        env=clean_env(NEXT_PUBLIC_API_URL=api_origin, NEXT_PUBLIC_SITE_URL=web_origin, NEXT_TELEMETRY_DISABLED="1"),
    )
    assert build.returncode == 0, f"next build failed:\n{build.stdout[-3000:]}\n{build.stderr[-2000:]}"

    node.init_key()
    node.start_api()
    server = Process(
        "web", ["npm", "run", "start", "--", "--port", str(port), "--hostname", "127.0.0.1"],
        env=clean_env(NEXT_PUBLIC_API_URL=api_origin, NEXT_PUBLIC_SITE_URL=web_origin, NEXT_TELEMETRY_DISABLED="1"),
        cwd=WEB_DIR, log_path=node.root / "logs" / "web.log",
    )
    node.extra.append(server)
    server.wait_for_http(f"{web_origin}/papers")
    with node.client() as http:
        paper = publish_listed_paper(node, http, title="Seen from the web")
        yield web_origin, node, http, paper


def test_every_page_carries_the_security_headers(web):
    origin, node, *_ = web
    for path in ("/", "/papers", "/policies", "/network", "/search", "/does-not-exist"):
        response = httpx.get(f"{origin}{path}", follow_redirects=False)
        headers = response.headers
        csp = headers["content-security-policy"]
        assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp and "object-src 'none'" in csp, (path, csp)
        # The page may talk to its own API and to nothing else.
        assert f"connect-src 'self' {node.base_url}" in csp, (path, csp)
        assert "'unsafe-eval'" not in csp, (path, csp)
        assert headers["x-frame-options"] == "DENY", path
        assert headers["x-content-type-options"] == "nosniff", path
        assert headers["referrer-policy"] == "no-referrer", path
        assert "camera=()" in headers["permissions-policy"], path


def test_the_feed_shows_the_papers_the_api_lists(web):
    origin, _, _, paper = web
    page = httpx.get(f"{origin}/papers")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    # Server-rendered, or fetched by the page: either way it ends up on the screen,
    # and the data is in the first response when it is rendered on the server.
    assert paper.title in page.text or paper.short_id in page.text or "Scholium" in page.text


def test_a_paper_page_renders_on_the_server_from_the_api(web):
    origin, _, _, paper = web
    page = httpx.get(f"{origin}/p/{paper.short_id}")
    assert page.status_code == 200, page.text[:500]
    assert paper.title in page.text, "the paper page did not render the title the API serves"
    assert paper.short_id in page.text


def test_an_unknown_paper_is_a_404_page_not_an_error(web):
    origin, *_ = web
    missing = httpx.get(f"{origin}/p/sch:aaaa-bbbb-cccc")
    assert missing.status_code == 404, missing.status_code
    assert "text/html" in missing.headers["content-type"]
    assert httpx.get(f"{origin}/nowhere/at/all").status_code == 404


def test_static_pages_and_metadata_are_served(web):
    origin, *_ = web
    for path in ("/policies", "/network", "/search", "/signin", "/manifest.webmanifest", "/icon.svg"):
        assert httpx.get(f"{origin}{path}").status_code == 200, path


def test_the_browser_can_call_the_api_from_the_web_origin(web):
    origin, node, http, paper = web
    preflight = http.options(
        "/v1/records",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "authorization,content-type"},
    )
    assert preflight.headers["access-control-allow-origin"] == origin
    read = http.get(f"/v1/papers/{paper.short_id}", headers={"Origin": origin})
    assert read.headers["access-control-allow-origin"] == origin


# --------------------------------------------------------------------------- the lockup
#
# docs/brand is the source of truth for the wordmark; these tests read it from there
# and check what the *running* web app, share-card renderer and mailer put out.

BRAND_DIR = REPO_ROOT / "docs" / "brand"
WORDMARK = json.loads((BRAND_DIR / "scholium-wordmark.json").read_text())
#: docs/design.md section 3: the ink token in the light theme, and what the cards and e-mails draw it with.
INK = "#1B1D22"
#: Pages that show BrandLogo: the global navigation, the home page and the sign-in layout.
#: (The root not-found and error pages show the glyph alone, docs/design.md section 2.)
LOCKUP_PAGES = ("/", "/signin", "/papers", "/policies")


def _number(value: float) -> str:
    return f"{value:g}"


#: The wordmark's own view box: from the pen origin to the drawing's right edge, the lockup's full height.
WORDMARK_VIEW_BOX = " ".join(
    _number(round(n, 2))
    for n in (WORDMARK["pen_origin_x"], 0, WORDMARK["view_box"][2] - WORDMARK["pen_origin_x"], WORDMARK["view_box"][3])
)
#: Width over height of the ink of the wordmark (excluding the glyph), whatever the scale.
WORDMARK_INK_ASPECT = (WORDMARK["ink"][2] - WORDMARK["ink"][0]) / (WORDMARK["ink"][3] - WORDMARK["ink"][1])


class _Page(HTMLParser):
    """What a page says about the lockup, the stylesheet and the share card."""

    def __init__(self, html: str) -> None:
        super().__init__(convert_charrefs=True)
        self.lockups: list[dict] = []
        self.marks: list[dict] = []
        self.wordmarks: list[dict] = []
        self.stylesheets: list[str] = []
        self.meta: dict[str, str] = {}
        self._wordmark: dict | None = None
        self._title = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = {name: value or "" for name, value in attrs}
        classes = attrs.get("class", "").split()
        if "sch-brand-mark" in classes:
            self.marks.append(attrs)
        if tag == "span" and "sch-brand-logo" in classes:
            self.lockups.append(attrs)
        elif tag == "span" and "sch-brand-logo__wordmark" in classes:
            self._wordmark = {"span": attrs, "svg": None, "titles": [], "paths": []}
            self.wordmarks.append(self._wordmark)
        elif self._wordmark is not None and tag == "svg":
            self._wordmark["svg"] = attrs
        elif self._wordmark is not None and tag == "title":
            self._title = True
        elif self._wordmark is not None and tag == "path":
            self._wordmark["paths"].append(attrs)
        elif tag == "link" and attrs.get("rel") == "stylesheet" and attrs.get("href"):
            self.stylesheets.append(attrs["href"])
        elif tag == "meta" and "content" in attrs:
            self.meta[attrs.get("property") or attrs.get("name") or ""] = attrs["content"]

    def handle_data(self, data):
        if self._title and self._wordmark is not None:
            self._wordmark["titles"].append(data)

    def handle_endtag(self, tag):
        if tag == "title":
            self._title = False
        elif tag == "span":
            self._wordmark = None


def _page(origin: str, path: str) -> _Page:
    response = httpx.get(f"{origin}{path}", follow_redirects=False)
    assert "text/html" in response.headers["content-type"], (path, response.headers["content-type"])
    return _Page(response.text)


@pytest.mark.parametrize("path", LOCKUP_PAGES)
def test_every_page_draws_the_wordmark_as_the_outlined_path_from_the_brand_source(web, path):
    origin, *_ = web
    page = _page(origin, path)
    assert page.wordmarks, f"{path} shows no lockup wordmark"
    assert len(page.lockups) == len(page.wordmarks), (path, page.lockups)
    for lockup in page.lockups:
        assert lockup.get("role") == "img" and lockup.get("aria-label") == "Scholium", lockup
    for wordmark in page.wordmarks:
        assert wordmark["span"].get("aria-hidden") == "true", wordmark["span"]
        # The same inline drawing, cropped at the pen origin, and nothing else.
        assert wordmark["svg"]["viewbox"] == WORDMARK_VIEW_BOX, wordmark["svg"]  # HTMLParser lower-cases names
        assert wordmark["titles"] == ["scholium"], wordmark["titles"]
        assert [(p["d"], p.get("fill")) for p in wordmark["paths"]] == [(WORDMARK["path"], "currentColor")]
        # Nothing types the word: no inline style, so no font can be chosen for it.
        assert "style" not in wordmark["span"] and "style" not in wordmark["svg"]


def test_the_not_found_page_shows_the_glyph_alone_not_the_lockup(web):
    origin, *_ = web
    response = httpx.get(f"{origin}/does-not-exist")
    assert response.status_code == 404
    page = _Page(response.text)
    # The card's large glyph (and the footer's small one): marks only, never the lockup.
    assert {mark.get("data-variant") for mark in page.marks} == {"glyph"}, page.marks
    assert "lg" in {mark.get("data-size") for mark in page.marks}, page.marks
    assert page.lockups == [] and page.wordmarks == []


def test_the_stylesheet_inks_the_wordmark_from_the_token_and_sets_no_typeface(web):
    origin, *_ = web
    page = _page(origin, "/signin")
    assert page.stylesheets, "the sign-in page links no stylesheet"
    css = "".join(httpx.get(urljoin(origin, href)).text for href in page.stylesheets)
    rules = re.findall(r"([^{}]*sch-brand-logo__wordmark[^{}]*)\{([^}]*)\}", css)
    assert rules, "the shipped stylesheet has no rule for the lockup's wordmark"
    for selector, body in rules:
        for typeface in ("font-family", "font-weight", "font-size-adjust", "vertical-align"):
            assert typeface not in body, (selector, body)
    bodies = " ".join(body for _, body in rules)
    assert re.search(r"color:\s*var\(--ink\)", bodies), bodies
    assert "220.95" in bodies, "the wordmark svg is not sized to 220.95/54 of the mark height"


def test_scholium_display_is_never_served_as_a_font(web):
    origin, *_ = web
    page = _page(origin, "/signin")
    css = "".join(httpx.get(urljoin(origin, href)).text for href in page.stylesheets)
    assert not re.search(r"scholium\s*display", css, re.IGNORECASE), "a stylesheet names Scholium Display"
    shipped = [
        path.name for root in (WEB_DIR / ".next" / "static", WEB_DIR / "public") for path in root.rglob("*") if path.is_file()
    ]
    fonts = [name for name in shipped if re.search(r"scholium.?display|\.otf$", name, re.IGNORECASE)]
    assert fonts == [], f"the web app ships a Scholium Display font file: {fonts}"
    for url in ("/brand/ScholiumDisplay-Bold.otf", "/fonts/ScholiumDisplay-Bold.otf", "/ScholiumDisplay-Bold.otf"):
        assert httpx.get(f"{origin}{url}").status_code == 404, url


@pytest.mark.parametrize(
    ("served", "source"),
    [
        ("scholium-logo-light.png", "scholium-lockup-light.png"),
        ("scholium-logo-dark.png", "scholium-lockup-dark.png"),
        ("scholium-lockup-email.png", "scholium-lockup-email.png"),
    ],
)
def test_the_lockup_images_are_served_as_the_brand_source_has_them(web, served, source):
    origin, *_ = web
    response = httpx.get(f"{origin}/brand/{served}")
    assert response.status_code == 200, served
    assert response.headers["content-type"] == "image/png", response.headers["content-type"]
    assert response.content == (BRAND_DIR / source).read_bytes()
    width, height = png_size(response.content)
    # The page lockups are 1200 x 380 renders; the e-mail lockup is the 170 x 32 header at 2x.
    assert (width, height) == ((340, 64) if "email" in served else (1200, 380)), (served, width, height)


def _card(origin: str, url: str):
    response = httpx.get(urljoin(origin, url))
    assert response.status_code == 200, (url, response.status_code, response.text[:300])
    assert response.headers["content-type"] == "image/png", (url, response.headers["content-type"])
    assert png_size(response.content) == (1200, 630), url
    return decode_png(response.content)


def _wordmark_box(card, region=None):
    """Where the card drew the outlined wordmark: the only thing in the ink colour in ``region``."""
    box = ink_box(card, INK, region=region)
    assert box is not None, "the card draws nothing in the ink colour"
    return box


#: docs/brand's own render of the light lockup (1200 x 380): the wordmark is the only ink-coloured thing in it.
REFERENCE_LOCKUP = decode_png((BRAND_DIR / "scholium-lockup-light.png").read_bytes())
REFERENCE_WORDMARK_BOX = ink_box(REFERENCE_LOCKUP, INK)


def _assert_outlined_wordmark(card, box):
    """The card's ink is the brand's wordmark: same proportions, and the same letter shapes at any scale."""
    left, top, right, bottom = box
    aspect = (right - left) / (bottom - top)
    assert aspect == pytest.approx(WORDMARK_INK_ASPECT, rel=0.04), (box, aspect, WORDMARK_INK_ASPECT)
    # Typed text in another face would have a similar width and height but other shapes.
    overlap = ink_overlap(card, box, REFERENCE_LOCKUP, REFERENCE_WORDMARK_BOX, INK)
    assert overlap > 0.75, f"the wordmark on the card matches the brand's drawing only {overlap:.2f}: {box}"


def test_the_site_share_card_is_a_1200_by_630_png_with_the_outlined_wordmark(web):
    origin, *_ = web
    # The page advertises the card, the card is what that address serves.
    advertised = _Page(httpx.get(f"{origin}/").text).meta.get("og:image")
    assert advertised and "/opengraph-image" in advertised, advertised
    card = _card(origin, advertised)
    box = _wordmark_box(card)
    _assert_outlined_wordmark(card, box)
    # Centred on the card, as the lockup is on the design's site card.
    assert abs((box[0] + box[2]) / 2 - card.width / 2) < card.width * 0.08, box
    assert _card(origin, "/twitter-image").width == 1200


def test_the_paper_share_card_carries_the_lockup_in_its_corner(web):
    origin, _, _, paper = web
    page = _Page(httpx.get(f"{origin}/p/{paper.short_id}").text)
    advertised = page.meta.get("og:image")
    assert advertised and f"/p/{quote(paper.short_id, safe='')}/opengraph-image" in advertised, advertised
    card = _card(origin, advertised)
    # The corner lockup sits bottom-right; the title and byline are on the left and above.
    corner = (card.width // 2, card.height // 2, card.width, card.height)
    box = _wordmark_box(card, region=corner)
    _assert_outlined_wordmark(card, box)
    assert box[2] > card.width * 0.8 and box[3] > card.height * 0.8, box


def _html_part(mail) -> str:
    parts = [part for part in mail.message.walk() if part.get_content_type() == "text/html"]
    return "".join(part.get_payload(decode=True).decode("utf-8", "replace") for part in parts)


def test_the_notification_email_header_loads_the_lockup_from_this_web_origin(web):
    origin, node, *_ = web
    assert node.smtp is not None
    # The author's verification mail, sent by `python -m app` while the paper was published.
    mail = node.smtp.wait_for(
        lambda m: m.message.is_multipart() and "scholium-lockup-email.png" in _html_part(m),
        what="a notification e-mail whose HTML part carries the lockup image",
    )
    html = _html_part(mail)
    header = html.split("<h1", 1)[0]
    images = re.findall(r"<img\b[^>]*>", header)
    assert len(images) == 1, images
    attributes = dict(re.findall(r'([\w-]+)="([^"]*)"', images[0]))
    assert attributes["src"] == f"{origin}/brand/scholium-lockup-email.png", attributes
    assert (attributes["width"], attributes["height"], attributes["alt"], attributes["border"]) == (
        "170", "32", "Scholium", "0",
    ), attributes
    assert "display:block" in attributes["style"], attributes
    # One image holds the whole lockup: no serif text, no second image, no font in the header.
    assert "serif" not in header.lower() and "font-family" not in header.lower(), header
    assert "<svg" not in html.lower()
    # The plain-text alternative is untouched: text only, with the link the recipient needs.
    assert "<" not in mail.body and "Open:" in mail.body, mail.body
    # What the mail points at is what the web app serves, at twice its displayed size.
    image = httpx.get(attributes["src"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert image.content == (BRAND_DIR / "scholium-lockup-email.png").read_bytes()
    assert png_size(image.content) == (2 * int(attributes["width"]), 2 * int(attributes["height"]))
