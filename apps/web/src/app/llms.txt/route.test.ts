// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, LLMS_TXT_MARKDOWN, absoluteLinks, getLlmsTxt } from "./route";

/**
 * `/llms.txt` is what an answer engine reads before it fetches a page. These
 * tests check the two things that make it useful: it is the delivered
 * markdown, and every link in it is an absolute URL on this deployment's own
 * origin rather than a domain baked into the source.
 */

const SITE = "https://scholium.test";

/** The delivered document, one level above `apps`. */
const DOCUMENT = fileURLToPath(
  new URL("../../../../../docs/homepage/llms.txt", import.meta.url),
);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every markdown link destination in a body. */
function links(text: string): string[] {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
}

describe("GET /llms.txt", () => {
  it("answers 200 as UTF-8 plain text", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("contains the title, one-line summary, key facts, pages and name", async () => {
    const body = await (await GET()).text();

    expect(body.startsWith("# Scholium\n\n> ")).toBe(true);
    expect(body).toContain("## Key facts");
    expect(body).toContain("## Pages");
    expect(body).toContain("## Name");
  });

  it("is the markdown in docs/homepage/llms.txt", async () => {
    const delivered = readFileSync(DOCUMENT, "utf8");
    const origin = new URL(links(delivered)[0]).origin;

    // The document pins one domain; the route builds the same links from
    // resolveSiteUrl. Substituting the origin must leave the texts identical.
    expect(await (await GET()).text()).toBe(delivered.replaceAll(origin, SITE));
  });

  it("makes every link absolute on the site's own origin", async () => {
    const body = await (await GET()).text();
    const found = links(body);

    expect(found.length).toBeGreaterThanOrEqual(6);
    for (const link of found) {
      expect(link.startsWith(`${SITE}/`)).toBe(true);
    }
    expect(found).toEqual([
      `${SITE}/`,
      `${SITE}/papers`,
      `${SITE}/search`,
      `${SITE}/verify`,
      `${SITE}/network`,
      `${SITE}/policies`,
    ]);
  });
});

describe("absoluteLinks", () => {
  it("rewrites root-relative destinations and leaves prose alone", () => {
    const text = "See [Papers](/papers) and /not-a-link; offline: `x /y`.";

    expect(absoluteLinks(text, "https://example.test/")).toBe(
      "See [Papers](https://example.test/papers) and /not-a-link; offline: `x /y`.",
    );
  });

  it("builds from the site URL it is given", () => {
    expect(getLlmsTxt("https://other.test")).toContain("](https://other.test/papers)");
  });
});
