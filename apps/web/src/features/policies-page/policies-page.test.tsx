// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PoliciesPage } from "./policies-page";
import { policyAnchorId, policyHref, type PolicyClause } from "./policies";

const CLAUSES: readonly PolicyClause[] = [
  {
    id: "MOD-01",
    title: "Out of scope",
    text: "Scholium lists scholarly manuscripts within the categories the node has opened.",
  },
  {
    id: "MOD-02",
    title: "Plagiarism and unattributed overlap",
    text: "A submission must attribute every source it draws on.",
  },
];

afterEach(cleanup);

describe("PoliciesPage with server data", () => {
  it("shows the page title, the clause count and every clause", () => {
    render(<PoliciesPage initialClauses={CLAUSES} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Moderation policies" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("2 clauses");

    for (const clause of CLAUSES) {
      expect(screen.getByRole("heading", { level: 2, name: clause.title })).toBeTruthy();
      expect(screen.getByText(clause.text)).toBeTruthy();
    }
  });

  it("gives every clause the anchor a decision banner links to", () => {
    const { container } = render(<PoliciesPage initialClauses={CLAUSES} />);

    for (const clause of CLAUSES) {
      const anchor = policyAnchorId(clause.id);
      const target = container.querySelector(`#${anchor}`);
      expect(target).not.toBeNull();
      expect(target?.tagName).toBe("LI");

      const link = within(target as HTMLElement).getByRole("link", {
        name: `Link to clause ${clause.id}: ${clause.title}`,
      });
      expect(link.getAttribute("href")).toBe(policyHref(clause.id));
      expect(link.getAttribute("href")).toBe(`/policies#${clause.id}`);
    }
  });

  it("keeps the API order in the list", () => {
    const { container } = render(<PoliciesPage initialClauses={CLAUSES} />);

    const ids = Array.from(container.querySelectorAll("li")).map((item) => item.id);
    expect(ids).toEqual(["MOD-01", "MOD-02"]);
  });

  it("shows the one-sentence empty state when there are no clauses", () => {
    render(<PoliciesPage initialClauses={[]} />);

    expect(screen.getByRole("status").textContent).toMatch(
      /No moderation policy clauses have been published yet/,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("PoliciesPage client fallback", () => {
  it("fetches once on mount when the server supplied no clauses", async () => {
    const load = vi.fn(async () => CLAUSES);

    render(<PoliciesPage loadPolicies={load} />);

    expect(await screen.findByText(CLAUSES[0].title)).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("2 clauses");
  });

  it("announces the loading state while the request is in flight", () => {
    const load = vi.fn(() => new Promise<readonly PolicyClause[]>(() => {}));

    render(<PoliciesPage loadPolicies={load} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Loading moderation policies…",
    );
  });

  it("renders a retryable notice when the load fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("The API is down."));

    render(<PoliciesPage loadPolicies={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load the policies");
    expect(alert.textContent).toContain("The API is down.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries after a failure and shows the clauses when that succeeds", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("The API is down."))
      .mockResolvedValueOnce(CLAUSES);

    render(<PoliciesPage loadPolicies={load} />);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(CLAUSES[0].title)).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("does not fetch when the server already supplied clauses", () => {
    const load = vi.fn(async () => CLAUSES);

    render(<PoliciesPage initialClauses={CLAUSES} loadPolicies={load} />);

    expect(load).not.toHaveBeenCalled();
  });
});
