"""The web app as shipped: ``next build`` then ``next start``, in front of a real node.

The browser journeys (``npm run test:e2e``, Playwright) drive a browser through
this same build; this file is the part that needs no browser: the production
build must succeed, the server must start, every response must carry the
security headers, and pages that are rendered on the server must show what the
API holds.  ``NEXT_PUBLIC_API_URL`` is baked into the bundle and the CSP at build
time, so the node's address is chosen before the build and the node started on
it afterwards.

Needs ``npm install`` to have been run and takes about a minute (the build).
Select with ``-m web``; exclude with ``-m "not web"``.
"""

from __future__ import annotations

import shutil
import subprocess

import httpx
import pytest

from e2e_harness import WEB_DIR, Process, clean_env, free_port, publish_listed_paper

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
