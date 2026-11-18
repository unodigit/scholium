// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppealCard } from "./appeal-card";
import type { AppealCase, AppealSubject } from "./appeals";

afterEach(cleanup);

const TITLE = "Sparse attention without the quadratic cost";

function versionAppeal(overrides: Partial<AppealCase> = {}): AppealCase {
  return {
    appealCid: "bafy-appeal-1",
    decisionCid: "bafy-decision-1",
    appellantDid: "did:key:z6MkAuthor",
    grounds: "The paper is squarely in scope.",
    filedAt: "2027-05-04T09:30:00Z",
    original: {
      action: "reject",
      clause: "MOD-01",
      reason: "Out of scope.",
      moderatorDid: "did:key:z6MkModerator",
      versionCid: "bafy-version-1",
    },
    paper: { title: TITLE, versionId: "sch:k3f9-q2xz-7mwd/v1", versionCid: "bafy-version-1" },
    verdict: null,
    ...overrides,
  };
}

function postSubject(overrides: Partial<AppealSubject> = {}): AppealSubject {
  return {
    kind: "post",
    recordType: "discussion.post",
    title: TITLE,
    excerpt: "This is wrong and you know it.",
    link: "/discussion/sch:k3f9-q2xz-7mwd",
    action: "hide",
    ...overrides,
  };
}

function postAppeal(overrides: Partial<AppealCase> = {}): AppealCase {
  return {
    ...versionAppeal(),
    original: {
      action: "hide",
      clause: "MOD-09",
      reason: "Abusive.",
      moderatorDid: "did:key:z6MkModerator",
      versionCid: "bafy-post-1",
    },
    paper: null,
    subject: postSubject(),
    ...overrides,
  };
}

function card(appeal: AppealCase) {
  render(<AppealCard appeal={appeal} loadPerson={async () => null} />);
  return within(screen.getByRole("article"));
}

function occurrences(text: string, of: string): number {
  return text.split(of).length - 1;
}

describe("the panel line", () => {
  it("is shown to a member of the panel", () => {
    const view = card(versionAppeal({ viewerOnPanel: true }));

    expect(view.getByText("You're on the appeal panel")).toBeTruthy();
  });

  it("is not shown to a viewer who holds no seat, such as the deciding moderator", () => {
    const view = card(versionAppeal({ viewerOnPanel: false }));

    expect(view.queryByText(/on the appeal panel/)).toBeNull();
  });

  it("is not shown when nothing says the viewer holds a seat", () => {
    const view = card(versionAppeal());

    expect(view.queryByText(/on the appeal panel/)).toBeNull();
  });

  it("does not repeat the paper's title: it is stated once, in the heading", () => {
    card(versionAppeal({ viewerOnPanel: true }));

    const article = screen.getByRole("article");
    expect(occurrences(article.textContent ?? "", TITLE)).toBe(1);
    expect(within(article).getByRole("heading", { name: TITLE })).toBeTruthy();
  });
});

describe("an appeal against a hidden post", () => {
  it("names what was hidden: the kind of record, the paper and the post's words", () => {
    const view = card(postAppeal());

    expect(view.getByText("Hidden post on 'Sparse attention without the quadratic cost': 'This is wrong and you know it.'")).toBeTruthy();
    expect(view.getByRole("link", { name: "MOD-09" }).getAttribute("href")).toBe("/policies#MOD-09");
    expect(view.getByText("Abusive.")).toBeTruthy();
  });

  it("states the paper's title once, not in the heading as well", () => {
    card(postAppeal());

    const article = screen.getByRole("article");
    expect(occurrences(article.textContent ?? "", TITLE)).toBe(1);
    expect(within(article).getByRole("heading", { name: "Appeal of a hidden post" })).toBeTruthy();
  });

  it("links to the post in its thread, and never offers the paper", () => {
    const view = card(postAppeal());

    expect(view.getByRole("link", { name: "Read the post" }).getAttribute("href")).toBe(
      "/discussion/sch:k3f9-q2xz-7mwd",
    );
    expect(view.queryByRole("link", { name: "Read the paper" })).toBeNull();
  });

  it("says review for a review", () => {
    const view = card(
      postAppeal({ subject: postSubject({ kind: "review", recordType: "review.formal", link: "/reviews/sch:k3f9-q2xz-7mwd" }) }),
    );

    expect(view.getByText(/^Hidden review on /)).toBeTruthy();
    expect(view.getByRole("link", { name: "Read the review" }).getAttribute("href")).toBe(
      "/reviews/sch:k3f9-q2xz-7mwd",
    );
  });

  it("leaves out the words it cannot read rather than inventing them", () => {
    const view = card(postAppeal({ subject: postSubject({ title: null, excerpt: null, link: null }) }));

    expect(view.getByText("Hidden post")).toBeTruthy();
    expect(view.queryByRole("link", { name: /Read the/ })).toBeNull();
  });

  it("never prints the raw action word", () => {
    card(postAppeal({ subject: null }));

    expect(screen.getByRole("article").textContent).not.toMatch(/\bhide under policy\b/);
  });
});

describe("an appeal against a paper", () => {
  it("still offers the paper", () => {
    const view = card(versionAppeal({ viewerOnPanel: true }));

    expect(view.getByRole("link", { name: "Read the paper" }).getAttribute("href")).toBe("/mod/bafy-version-1");
  });
});
