// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateMetadata } from "./page";

/**
 * Bug: `/c/xx.FAKE` answers 404 and renders the not-found page, but its tab
 * was titled "xx.FAKE · Scholium", because `generateMetadata` named the
 * category before the page found out that no paper is filed under it. The
 * metadata must reach the same verdict as the page, so the 404 is titled by
 * the not-found page ("Not found · Scholium").
 */

function stubPapers(items: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ items, nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function params(category: string) {
  return Promise.resolve({ category });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/c/{category} metadata for a category that does not exist", () => {
  it("is a 404, not a title naming the invented category", async () => {
    stubPapers([]);

    const thrown = await generateMetadata({ params: params("xx.FAKE") }).catch(
      (error: unknown) => error,
    );

    expect(String((thrown as { digest?: string }).digest ?? "")).toMatch(
      /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it("still titles a category the taxonomy names, even with no papers yet", async () => {
    stubPapers([]);

    const metadata = await generateMetadata({ params: params("cs.AI") });

    expect(metadata.title).toBe("cs.AI · Artificial Intelligence");
  });

  it("does not turn an unreachable API into a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const metadata = await generateMetadata({ params: params("xx.FAKE") });

    expect(metadata.title).toBe("xx.FAKE");
  });
});
