// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `next/link` needs the App Router's context; the docs pages are server
 * rendered, so these tests only need the destination the reader would get.
 */
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

import {
  DocsSearch,
  MAX_DOCS_SEARCH_RESULTS,
  searchDocs,
  type DocsSearchEntry,
} from "./docs-search";

afterEach(cleanup);

const ENTRIES: DocsSearchEntry[] = [
  { title: "Your account", href: "/docs/your-account", chapter: "Your account" },
  {
    title: "Sign in with a passkey",
    href: "/docs/your-account#sign-in-with-a-passkey",
    chapter: "Your account",
  },
  {
    title: "If sign-in fails",
    href: "/docs/your-account#if-sign-in-fails",
    chapter: "Your account",
  },
  {
    title: "Publishing a paper",
    href: "/docs/publishing-a-paper",
    chapter: "Publishing a paper",
  },
  { title: "Passkey", href: "/docs/glossary#passkey", chapter: "Glossary" },
  { title: "The submit wizard", href: "/docs/publishing-a-paper#the-submit-wizard", chapter: "Publishing a paper" },
];

function view(entries: DocsSearchEntry[] = ENTRIES) {
  return render(<DocsSearch entries={entries} />);
}

/** The labelled search field. */
function field(): HTMLInputElement {
  return screen.getByLabelText("Search the docs") as HTMLInputElement;
}

describe("searchDocs", () => {
  it("matches titles whatever their case, in index order", () => {
    expect(searchDocs(ENTRIES, "PASSKEY").map((entry) => entry.title)).toEqual([
      "Sign in with a passkey",
      "Passkey",
    ]);
  });

  it("needs every word of the query", () => {
    expect(searchDocs(ENTRIES, "sign fails").map((entry) => entry.title)).toEqual([
      "If sign-in fails",
    ]);
    expect(searchDocs(ENTRIES, "passkey wizard")).toEqual([]);
  });

  it("returns nothing for an empty or blank query", () => {
    expect(searchDocs(ENTRIES, "")).toEqual([]);
    expect(searchDocs(ENTRIES, "   ")).toEqual([]);
  });

  it(`lists at most ${MAX_DOCS_SEARCH_RESULTS} matches`, () => {
    const many = Array.from({ length: MAX_DOCS_SEARCH_RESULTS + 6 }, (_, index) => ({
      title: `Chapter note ${index}`,
      href: `/docs/note-${index}`,
      chapter: "Glossary",
    }));

    expect(searchDocs(many, "chapter note")).toHaveLength(MAX_DOCS_SEARCH_RESULTS);
    expect(MAX_DOCS_SEARCH_RESULTS).toBe(12);
  });
});

describe("DocsSearch", () => {
  it("labels the field 'Search the docs' and lists nothing before a query", () => {
    view();

    expect(field()).toBeTruthy();
    expect(field().getAttribute("type")).toBe("search");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("lists the chapter 2 sign-in section for 'passkey', with the chapter beside it", () => {
    view();

    fireEvent.change(field(), { target: { value: "passkey" } });

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/docs/your-account#sign-in-with-a-passkey",
      "/docs/glossary#passkey",
    ]);

    const signIn = screen.getByRole("link", { name: "Sign in with a passkey" });
    expect(signIn.getAttribute("href")).toBe(
      "/docs/your-account#sign-in-with-a-passkey",
    );
    expect(signIn.closest("li")?.textContent).toContain("Your account");
  });

  it("filters as each character arrives", () => {
    view();

    fireEvent.change(field(), { target: { value: "wi" } });
    expect(screen.queryAllByRole("link").map((link) => link.textContent)).toEqual([
      "Sign in with a passkey",
      "The submit wizard",
    ]);

    fireEvent.change(field(), { target: { value: "wiz" } });
    expect(screen.queryAllByRole("link").map((link) => link.textContent)).toEqual([
      "The submit wizard",
    ]);

    fireEvent.change(field(), { target: { value: "" } });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("says 'No matches for …' when nothing matches", () => {
    view();

    fireEvent.change(field(), { target: { value: "quasar" } });

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText(/No matches for/).textContent).toBe(
      "No matches for “quasar”.",
    );
  });

  it("focuses the field when the reader presses '/'", () => {
    view();
    expect(document.activeElement).not.toBe(field());

    fireEvent.keyDown(document, { key: "/" });

    expect(document.activeElement).toBe(field());
  });

  it("leaves '/' alone while the reader is typing in another field", () => {
    const { container } = render(
      <div>
        <textarea aria-label="A note" />
        <DocsSearch entries={ENTRIES} />
      </div>,
    );

    const note = within(container).getByLabelText("A note") as HTMLTextAreaElement;
    note.focus();

    fireEvent.keyDown(note, { key: "/" });

    expect(document.activeElement).toBe(note);
  });
});
