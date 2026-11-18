// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateMetadata } from "./ai/[...ref]/page";

/**
 * The `/ai/{id}[/v{n}]` document title (docs/design.md §4): like `/reviews`,
 * `/proof` and `/meta`, it names the paper being advised on — never the raw
 * `sch:` id — with the root layout's " · Scholium" template appended to that.
 */

const PAPER = "6sel-2dio-orm6"; // a real id from the shared vectors
const TITLE = "Sparse attention without the quadratic cost";

/** The catalog's answer for one paper, the shape `loadPaper` reads. */
function stubPaper(title: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ title }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/ai document title", () => {
  it("uses the paper's title, so the tab reads like the other standalone pages", async () => {
    stubPaper(TITLE);

    const meta = await generateMetadata({
      params: Promise.resolve({ ref: [PAPER, "v2"] }),
    });

    // " · Scholium" is the root layout's template, so it is not repeated here.
    expect(meta.title).toBe(`AI pre-review · ${TITLE}`);
  });

  it("falls back to the id only when the paper's title cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 404,
            headers: { "content-type": "application/problem+json" },
          }),
      ),
    );

    const meta = await generateMetadata({
      params: Promise.resolve({ ref: [PAPER, "v2"] }),
    });

    expect(meta.title).toBe("AI pre-review of sch:6sel-2dio-orm6/v2");
  });

  it("names nothing when the address is not a paper id", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ ref: ["nope"] }),
    });
    expect(meta.title).toBe("AI pre-review");
  });
});
