// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConsentTracker } from "./consent-tracker";
import type { TrackerEntry } from "./consents";

afterEach(cleanup);

const entry = (over: Partial<TrackerEntry>): TrackerEntry => ({
  key: over.name ?? "x",
  name: "Ada Lovelace",
  monogram: "AL",
  detail: null,
  status: "waiting",
  isYou: false,
  roles: [],
  ...over,
});

describe("ConsentTracker", () => {
  it("shows an avatar, a name and a Waiting, Signed or Declined chip for each author", () => {
    render(
      <ConsentTracker
        entries={[
          entry({ name: "Mei Chen", monogram: "MC", status: "signed", isYou: true }),
          entry({ name: "Ada Lovelace", status: "waiting", detail: "ORCID iD · 0000-0002-1825-0097" }),
          entry({ name: "Grace Hopper", monogram: "GH", status: "declined" }),
        ]}
      />,
    );
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["signed", "waiting", "declined"]);
    expect(within(rows[0]).getByText("Signed")).toBeTruthy();
    expect(within(rows[1]).getByText("Waiting")).toBeTruthy();
    expect(within(rows[2]).getByText("Declined")).toBeTruthy();
    expect(rows[0].textContent).toContain("Mei Chen (you)");
    expect(rows[1].textContent).toContain("ORCID iD · 0000-0002-1825-0097");
    expect(rows.map((row) => row.querySelector(".sw-avatar")?.textContent)).toEqual(["MC", "AL", "GH"]);
  });

  it("never leaves the status to colour alone: every chip has an icon and a word", () => {
    render(
      <ConsentTracker
        entries={[entry({ status: "signed", key: "a" }), entry({ status: "waiting", key: "b" }), entry({ status: "declined", key: "c" })]}
      />,
    );
    const chips = Array.from(document.querySelectorAll(".sw-chip"));
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.querySelector("svg")).toBeTruthy();
      expect(chip.textContent?.trim()).toMatch(/^(Waiting|Signed|Declined)$/);
    }
    // Three different shapes, not one icon in three colours.
    const shapes = new Set(chips.map((chip) => chip.querySelector("svg")?.innerHTML));
    expect(shapes.size).toBe(3);
  });

  it("names each author's roles only when asked to", () => {
    const entries = [entry({ key: "a", name: "Mei Chen", roles: ["Software", "Validation"] }), entry({ key: "b", name: "Ada Lovelace", roles: [] })];
    const { rerender } = render(<ConsentTracker entries={entries} />);
    expect(document.querySelector(".sw-tracker__roles")).toBeNull();

    rerender(<ConsentTracker entries={entries} showRoles />);
    const roles = Array.from(document.querySelectorAll(".sw-tracker__roles"));
    // An author with no roles gets no empty line.
    expect(roles.map((role) => role.textContent)).toEqual(["Software, Validation"]);
  });

  it("falls back to a person glyph when there is no name to take letters from", () => {
    render(<ConsentTracker entries={[entry({ name: "did:key:z6Mk…", monogram: null })]} />);
    const avatar = document.querySelector(".sw-avatar")!;
    expect(avatar.querySelector("svg")).toBeTruthy();
    expect(avatar.textContent).toBe("");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the summary politely so a poll bringing news is heard", () => {
    render(<ConsentTracker entries={[entry({ status: "signed", key: "a" }), entry({ key: "b" })]} />);
    const summary = screen.getByRole("status");
    expect(summary.textContent).toBe("1 of 2 signed · 1 waiting");
  });

  it("shows the caption, an error in its place, and a decline notice over both", () => {
    const { rerender } = render(<ConsentTracker entries={[entry({})]} caption="Links go out when you submit." />);
    expect(screen.getByText("Links go out when you submit.")).toBeTruthy();

    rerender(<ConsentTracker entries={[entry({})]} caption="Links go out when you submit." error="Could not check." />);
    expect(screen.getByRole("alert").textContent).toBe("Could not check.");
    expect(screen.queryByText("Links go out when you submit.")).toBeNull();

    rerender(<ConsentTracker entries={[entry({ status: "declined" })]} caption="Links go out when you submit." />);
    expect(screen.getByText(/Ada Lovelace declined authorship, so this version is back in draft/)).toBeTruthy();
    expect(screen.queryByText("Links go out when you submit.")).toBeNull();
  });

  it("says so when no author is listed", () => {
    render(<ConsentTracker entries={[]} />);
    expect(screen.getByText("No authors are listed on this version.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("0 of 0 signed");
  });

  it("keeps ids apart when two trackers share a page", () => {
    render(
      <>
        <ConsentTracker entries={[]} idPrefix="a" />
        <ConsentTracker entries={[]} idPrefix="b" />
      </>,
    );
    expect(document.getElementById("a-title")).toBeTruthy();
    expect(document.getElementById("b-title")).toBeTruthy();
  });
});
