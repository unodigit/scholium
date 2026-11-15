// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MeSecurityRoutePage, { metadata } from "../../app/(dashboard)/me/security/page";

/**
 * `/me/security` is a client-fetched screen: the bearer token and the device
 * key live only in the browser, so the route renders the shell and lets the
 * client load the details after hydration. The first HTML must still name the
 * page and say what is happening, rather than rendering an empty body.
 */

describe("/me/security route", () => {
  it("renders the security shell and a loading line", () => {
    const html = renderToStaticMarkup(<MeSecurityRoutePage />);

    expect(html).toContain("Security");
    expect(html).toContain("scholium / me / security");
    expect(html).toContain("Loading your security settings");
  });

  it("does not render private details on the server", () => {
    const html = renderToStaticMarkup(<MeSecurityRoutePage />);

    expect(html).not.toContain("did:key:");
    expect(html).not.toContain("Rotate key");
  });

  it("names the page in its metadata", () => {
    expect(metadata.title).toBe("Security · Scholium");
    expect(metadata.description).toContain("3 of 5");
    expect(metadata.description).toContain("key rotation");
  });
});
