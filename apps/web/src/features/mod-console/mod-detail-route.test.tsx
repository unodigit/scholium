// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModDetailPage, {
  generateMetadata,
} from "../../app/(mod-console)/mod/[cid]/page";

/**
 * The detail route is the shell and a loading line in the first HTML: the
 * paper, its clauses and the passkey-gated decision all happen in the browser,
 * and the server must not call the API for a tier-4 page.
 */

const VERSION = "bafyreicincmn5eotnt4a7ik3wq7dohecjikpgxvbikftwgyyrdml6rszey";

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(cid = VERSION): Promise<string> {
  return ModDetailPage({ params: Promise.resolve({ cid }) }).then(
    renderToStaticMarkup,
  );
}

describe("mod detail route (server render)", () => {
  it("renders the detail shell and a loading line, and calls no API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = await render();

    expect(html).toContain("Moderation decision");
    expect(html).toContain("Loading the paper…");
    expect(html).toContain("<h1");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("This decision is a public signed record.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not put a sign-in prompt in the first HTML", async () => {
    const html = await render();

    expect(html).not.toContain("Sign in to continue");
    expect(html).not.toContain("Moderators only");
  });

  it("titles the page for the browser tab", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ cid: VERSION }),
    });
    expect(metadata.title).toBe("Moderation decision");
    expect(metadata.description).toContain(VERSION);
  });
});
