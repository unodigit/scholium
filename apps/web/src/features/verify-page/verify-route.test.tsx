// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import VerifyRoutePage, { metadata } from "../../app/(verify-page)/verify/page";
import { VERIFY_PATH, verifyHref } from "./verify-href";

/**
 * `/verify` is a server component that only reads the URL for a starting id.
 * The file is fingerprinted in the browser, so the first HTML response can
 * never contain a verdict about a file: only the form, the drop zone and a hint.
 */

const ID = "sch:6sel-2dio-orm6/v2"; // a real id from the shared vectors

const render = async (searchParams: { id?: string | string[] } = {}) =>
  renderToStaticMarkup(await VerifyRoutePage({ searchParams: Promise.resolve(searchParams) }));

describe("/verify route (server render)", () => {
  it("renders the page header, the id field and the drop zone", async () => {
    const html = await render();

    expect(html).toContain("<h1");
    expect(html).toContain("Verify a file");
    expect(html).toContain("The file never leaves your");
    expect(html).toContain('for="vp-id"');
    expect(html).toContain('type="file"');
    expect(html).toContain("Drop a file here");
    expect(html).toContain("Your file stays on this device");
    expect(html).toContain("Enter a version id and drop a file to compare them.");
  });

  it("never claims a verdict before a file has been read in the browser", async () => {
    for (const html of [await render(), await render({ id: ID })]) {
      expect(html).not.toContain("matches what the authors signed");
      expect(html).not.toContain("does not match what the authors signed");
      expect(html).not.toContain("Could not check");
      expect(html).not.toContain("vp-verdict__headline");
      expect(html).not.toContain("<details");
    }
  });

  it("starts with the id from the link", async () => {
    const html = await render({ id: ID });

    expect(html).toContain(`value="${ID}"`);
    expect(html).toContain(`Drop a file to compare it with the files signed for ${ID}.`);
    expect(html).not.toContain("vp-error");
  });

  it("says what is wrong with an id in the link that is not a version id", async () => {
    const html = await render({ id: "nonsense" });

    expect(html).toContain('value="nonsense"');
    expect(html).toContain("That is not a version id");
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain("Add the version");
  });

  it("asks for the version when the link names only the paper", async () => {
    expect(await render({ id: "sch:6sel-2dio-orm6" })).toContain("Add the version");
  });

  it("uses the first id when the link repeats the parameter", async () => {
    expect(await render({ id: [ID, "sch:other"] })).toContain(`value="${ID}"`);
  });

  it("does not put an absurdly long id into the page", async () => {
    const html = await render({ id: "x".repeat(5000) });
    expect(html).not.toContain("x".repeat(201));
  });

  it("escapes what the link carries instead of writing it into the page as markup", async () => {
    const html = await render({ id: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("titles the page", () => {
    expect(metadata.title).toBe("Verify a file · Scholium");
    expect(String(metadata.description)).toMatch(/exactly what the authors of a Scholium paper signed/);
  });
});

describe("verifyHref", () => {
  it("is /verify, or /verify with a version already filled in", () => {
    expect(VERIFY_PATH).toBe("/verify");
    expect(verifyHref()).toBe("/verify");
    expect(verifyHref("  ")).toBe("/verify");
    expect(verifyHref(ID)).toBe("/verify?id=sch%3A6sel-2dio-orm6%2Fv2");
  });

  it("round-trips through the route", async () => {
    const query = new URL(verifyHref(ID), "https://node.example").searchParams.get("id");
    expect(query).toBe(ID);
    expect(await render({ id: query! })).toContain(`value="${ID}"`);
  });
});
