// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateMetadata } from "./page";

/**
 * Bug: in a production build `/ui-kit/brand` renders the not-found page (the
 * layout refuses the gallery) but its tab stayed "Brand · UI kit · Scholium".
 * A page's metadata is resolved even when a layout throws `notFound()`, so the
 * metadata must reach the same verdict as the page and answer 404 too; the
 * not-found page then titles the tab "Not found · Scholium".
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/ui-kit/brand metadata", () => {
  it("answers 404 in a production build, like the page does", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const thrown = await Promise.resolve()
      .then(() => generateMetadata())
      .catch((error: unknown) => error);

    expect(String((thrown as { digest?: string }).digest ?? "")).toMatch(
      /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it("still titles the gallery in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(generateMetadata().title).toBe("Brand · UI kit");
  });
});
