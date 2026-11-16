// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProfileRoutePage from "../../app/(dashboard)/u/[did]/page";

/**
 * `/u/{did}` is server-rendered. A profile link carries a `did:key:…` whose
 * colons are percent-encoded (`/u/did%3Akey%3A…`), and Next hands the route
 * the *encoded* segment. The page must decode it once, both to fetch the
 * profile and to show the DID, or the API sees a DID that belongs to nobody
 * and answers with the empty pseudonymous view (name `—`, tier 0).
 */

const DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const ENCODED_DID = encodeURIComponent(DID);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The DID the API receives after its own single URL-decode of the path. */
function didFromRequest(input: RequestInfo | URL): string | null {
  const url = new URL(String(input));
  const prefix = "/v1/profiles/";
  const at = url.pathname.indexOf(prefix);
  if (at < 0) return null;
  return decodeURIComponent(url.pathname.slice(at + prefix.length));
}

function stubProfileApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const did = didFromRequest(input);
    if (did === DID) {
      return json({
        did,
        name: "Ada Lovelace",
        affiliation: "Analytical Engine Institute",
        orcid: "0000-0002-1825-0097",
        tier: 2,
        erased: false,
        reviews: [],
      });
    }
    // `GET /v1/profiles/{did}` answers 200 for any DID, with the empty
    // pseudonymous view when no profile was ever saved.
    return json({
      did: did ?? "",
      name: null,
      affiliation: null,
      orcid: null,
      tier: 0,
      erased: false,
      reviews: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function params(did: string) {
  return Promise.resolve({ did });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/u/{did} route (server render)", () => {
  it("decodes the route param once and shows the profile", async () => {
    stubProfileApi();

    const html = renderToStaticMarkup(
      await ProfileRoutePage({ params: params(ENCODED_DID) }),
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Analytical Engine Institute");
    expect(html).toContain("0000-0002-1825-0097");
    expect(html).toContain(`>${DID}<`);
    expect(html).not.toContain(ENCODED_DID);
    expect(html).not.toContain("—");
    expect(html).not.toContain(">0<");
  });

  it("asks the API for the decoded DID", async () => {
    const fetchMock = stubProfileApi();

    await ProfileRoutePage({ params: params(ENCODED_DID) });

    const requested = fetchMock.mock.calls.map((call) => didFromRequest(call[0]));
    expect(requested).toContain(DID);
    expect(requested).not.toContain(ENCODED_DID);
    // The DID is encoded exactly once in the request path.
    const path = new URL(String(fetchMock.mock.calls[0][0])).pathname;
    expect(path).toBe(`/v1/profiles/${ENCODED_DID}`);
  });

  it("leaves an already-decoded param alone", async () => {
    stubProfileApi();

    const html = renderToStaticMarkup(
      await ProfileRoutePage({ params: params(DID) }),
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(`>${DID}<`);
  });
});
