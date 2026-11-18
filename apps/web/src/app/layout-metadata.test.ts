// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the root layout tells the browser (title, description, theme colour,
 * the base URL for relative metadata) and the favicon set Next serves from
 * `src/app`. The icons are checked against the delivered files in
 * `docs/brand`: Next serves whatever sits at `app/icon.svg`, `app/favicon.ico`
 * and `app/apple-icon.png`, so a stale copy would quietly ship the wrong mark.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const read = (path: string) => readFileSync(here(path));
const delivered = (name: string) => read(`../../../../docs/brand/${name}`);

async function loadLayout() {
  vi.resetModules();
  return import("./site-metadata");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the root layout metadata", () => {
  it("titles pages 'Scholium', or '<page> · Scholium' when a page names itself", async () => {
    const { metadata } = await loadLayout();

    expect(metadata.title).toEqual({ default: "Scholium", template: "%s · Scholium" });
    const { template } = metadata.title as { template: string };
    expect(template.replace("%s", "Search")).toBe("Search · Scholium");
  });

  it("describes the site and names the application", async () => {
    const { metadata } = await loadLayout();

    expect(metadata.description).toBe("Signed, open preprints and peer review");
    expect(metadata.applicationName).toBe("Scholium");
  });

  it("resolves relative metadata against NEXT_PUBLIC_SITE_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://scholium.example");

    const { metadata } = await loadLayout();

    expect(metadata.metadataBase?.toString()).toBe("https://scholium.example/");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("falls back to http://localhost:3000 when NEXT_PUBLIC_SITE_URL is %s", async (_, value) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);

    const { metadata } = await loadLayout();

    expect(metadata.metadataBase?.toString()).toBe("http://localhost:3000/");
  });

  it("uses a configured loopback URL outside production as given", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SCHOLIUM_ENV", "dev");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3200");

    const { metadata } = await loadLayout();

    expect(metadata.metadataBase?.toString()).toBe("http://localhost:3200/");
  });

  it("still refuses a loopback URL in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHOLIUM_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3200");

    await expect(loadLayout()).rejects.toThrow(
      /must not point at localhost in production/,
    );
  });

  it("still refuses an unset URL in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHOLIUM_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");

    await expect(loadLayout()).rejects.toThrow(/must be set to a non-loopback/);
  });
});

describe("the root layout viewport", () => {
  it("colours the browser chrome paper in light mode and ink in dark mode", async () => {
    const { viewport } = await loadLayout();

    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#FBFAF7" },
      { media: "(prefers-color-scheme: dark)", color: "#14151A" },
    ]);
  });
});

describe("the favicon set Next serves from src/app", () => {
  it("icon.svg is exactly the delivered scholium-favicon.svg", () => {
    const served = read("./icon.svg");

    expect(served.equals(delivered("scholium-favicon.svg"))).toBe(true);

    const svg = served.toString("utf8");
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toMatch(/<rect[^>]*rx="6"[^>]*fill="#2F4BA0"/); // the rounded tile
    expect(svg).toContain('fill="#FBFAF7"'); // the page-with-lines and bracket
  });

  it("favicon.ico is the delivered favicon.ico", () => {
    expect(read("./favicon.ico").equals(delivered("favicon.ico"))).toBe(true);
  });

  it("apple-icon.png is the delivered 180x180 apple-touch-icon.png", () => {
    const served = read("./apple-icon.png");

    expect(served.equals(delivered("apple-touch-icon.png"))).toBe(true);
    // PNG IHDR: width and height are the two big-endian uint32s after the 8-byte
    // signature and the chunk's length and type.
    expect([served.readUInt32BE(16), served.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
