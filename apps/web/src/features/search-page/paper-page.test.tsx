// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaperPage } from "./paper-page";
import type { PaperView } from "./paper";

const PAPER: PaperView = {
  shortId: "sch:abcd-efgh-jklm",
  paperCid: "bafy-paper",
  versionCid: "bafy-version-2",
  n: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "An evaluation framework for meta-agents.",
  authors: [
    {
      did: "did:key:zMei",
      position: 1,
      creditRoles: ["Conceptualization"],
      name: "Mei Zhang",
      affiliation: "Example University",
      orcid: "0000-0002-1825-0097",
    },
    {
      did: "did:key:zAnon",
      position: 2,
      creditRoles: [],
      name: null,
      affiliation: null,
      orcid: null,
    },
  ],
  categories: ["cs.AI"],
  licence: "CC-BY-4.0",
  status: "reviewed",
  notices: [],
};

afterEach(cleanup);

describe("PaperPage", () => {
  it("shows the title, status and version", () => {
    render(<PaperPage paper={PAPER} />);

    expect(
      screen.getByRole("heading", { level: 1, name: PAPER.title }),
    ).toBeTruthy();
    expect(screen.getByText("Reviewed")).toBeTruthy();
    expect(screen.getByText("Version 2")).toBeTruthy();
  });

  it("lists the authors by their profile names, in byline order", () => {
    render(<PaperPage paper={PAPER} />);

    const authors = screen.getByRole("region", { name: "Authors" });
    const items = Array.from(authors.querySelectorAll(".sp-author-name")).map(
      (node) => node.textContent,
    );
    expect(items).toEqual(["Mei Zhang", "did:key:zAnon"]);
    expect(authors.textContent).toContain("Example University");
    expect(authors.textContent).toContain("Conceptualization");
  });

  it("shows the abstract", () => {
    render(<PaperPage paper={PAPER} />);
    expect(screen.getByText(PAPER.abstract)).toBeTruthy();
  });

  it("explains a paper it cannot show and offers the way back", () => {
    render(<PaperPage error="No paper with that id is listed on this node." />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Paper unavailable");
    expect(alert.textContent).toContain("No paper with that id is listed");
    expect(
      screen.getByRole("link", { name: "Back to search" }).getAttribute("href"),
    ).toBe("/search");
  });
});
