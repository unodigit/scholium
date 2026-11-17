// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicExportHref, SiteFooter } from "./index";

/*
 * Regression: /network, /verify, /policies and the node's public export had no
 * link anywhere in the UI, because no page had a footer. Every page now gets
 * one from the root layout. These tests pin what the footer holds, that it
 * follows the design tokens and clears the fixed phone tab bar, and that the
 * root layout really renders it below the page content.
 */

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children);
  return { default: Link };
});

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function renderFooter() {
  render(<SiteFooter />);
  return screen.getByRole("contentinfo");
}

describe("SiteFooter", () => {
  it("is the page's contentinfo landmark", () => {
    renderFooter();

    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it("links Network, Verify a file and Policies", () => {
    const footer = renderFooter();

    const link = (name: string) =>
      within(footer).getByRole("link", { name }).getAttribute("href");
    expect(link("Network")).toBe("/network");
    expect(link("Verify a file")).toBe("/verify");
    expect(link("Policies")).toBe("/policies");
  });

  it("links the public export on the API origin, noted as a CAR archive", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const footer = renderFooter();

    const link = within(footer).getByRole("link", { name: "Public export" });
    expect(link.getAttribute("href")).toBe(
      "http://localhost:8000/v1/export/archive.car",
    );

    const note = within(footer).getByText("CAR archive");
    expect(note.id).not.toBe("");
    expect(link.getAttribute("aria-describedby")).toBe(note.id);
  });

  it("follows NEXT_PUBLIC_API_URL for the export, like the paper page's archive link", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.scholium.example/");
    const footer = renderFooter();

    expect(
      within(footer).getByRole("link", { name: "Public export" }).getAttribute("href"),
    ).toBe("https://api.scholium.example/v1/export/archive.car");
    expect(publicExportHref("https://other.example")).toBe(
      "https://other.example/v1/export/archive.car",
    );
  });

  it("carries the BrandMark glyph, hidden from assistive technology", () => {
    const footer = renderFooter();

    const mark = footer.querySelector(".sch-brand-mark");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("data-variant")).toBe("glyph");
    expect(mark?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(within(footer).queryByRole("img")).toBeNull();
  });

  it("says what the site is, in the same words as the page description", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://scholium.example");
    const { metadata } = await import("../../app/site-metadata");
    const footer = renderFooter();

    expect(metadata.description).toBeTruthy();
    expect(within(footer).getByText(String(metadata.description))).toBeTruthy();
  });

  it("keeps the links in a named navigation list, all reachable by keyboard", () => {
    const footer = renderFooter();

    const nav = within(footer).getByRole("navigation", { name: "Footer" });
    const items = within(nav).getAllByRole("listitem");
    expect(items).toHaveLength(4);

    const links = within(footer).getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(footer.querySelectorAll("[tabindex]")).toHaveLength(0);
    // Reading order is tab order: the DOM order of the four links.
    expect(links.map((a) => a.textContent)).toEqual([
      "Network",
      "Verify a file",
      "Policies",
      "Public export",
    ]);
  });
});

describe("footer.css", () => {
  const css = readFileSync(join(here, "footer.css"), "utf8");
  const navCss = readFileSync(join(here, "../nav/nav.css"), "utf8");

  it("reads the design tokens and invents no colour", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
    expect(css).toContain("var(--rule)");
    expect(css).toContain("var(--ink)");
    expect(css).toContain("var(--ink-2)");
  });

  it("keeps its last line above the fixed phone tab bar", () => {
    // The tab bar is 56px plus the home-indicator inset...
    expect(navCss).toMatch(
      /\.gn-tabbar\s*\{[^}]*height:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    );
    // ...and below the 640px breakpoint the footer pads itself by the same.
    const phone = /@media \(width < 40rem\)\s*\{([\s\S]*?\n\})/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(
      /padding-block-end:[^;]*56px[^;]*env\(safe-area-inset-bottom, 0px\)/,
    );
  });

  it("gives every link a 44px target", () => {
    expect(css).toMatch(/\.sf-link\s*\{[^}]*min-block-size:\s*44px/);
  });

  it("wraps instead of scrolling sideways on a narrow screen", () => {
    expect(css).toMatch(/\.sf-links\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.sf-description\s*\{[^}]*min-inline-size:\s*0/);
  });
});

describe("the root layout", () => {
  const source = ts.createSourceFile(
    "layout.tsx",
    readFileSync(join(here, "../../app/layout.tsx"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  function tagName(node: ts.Node): string | undefined {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(source);
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(source);
    return undefined;
  }

  /** What `<body>` holds, in document order: `{children}` and each footer. */
  function bodyOrder(): string[] {
    const order: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isJsxExpression(node) && node.expression?.getText(source) === "children") {
        order.push("children");
      }
      if (tagName(node) === "SiteFooter") order.push("SiteFooter");
      ts.forEachChild(node, walk);
    };
    const findBody = (node: ts.Node): void => {
      if (tagName(node) === "body") {
        ts.forEachChild(node, walk);
        return;
      }
      ts.forEachChild(node, findBody);
    };
    findBody(source);
    return order;
  }

  it("imports the footer from components/footer", () => {
    const specifiers = source.statements
      .filter(ts.isImportDeclaration)
      .filter((statement) =>
        statement.importClause?.namedBindings?.getText(source).includes("SiteFooter"),
      )
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);

    expect(specifiers).toEqual(["../components/footer"]);
  });

  it("renders the footer once, in the body, below the page content", () => {
    expect(bodyOrder()).toEqual(["children", "SiteFooter"]);
  });
});
