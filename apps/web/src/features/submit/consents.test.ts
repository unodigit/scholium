import { afterEach, describe, expect, it, vi } from "vitest";

import { addAuthor, initialAuthors, shortDid, toggleCreditRole, type DraftAuthor } from "./authors";
import {
  consentSummary,
  consentsErrorMessage,
  countConsents,
  declineNotice,
  fetchConsents,
  toConsentStatus,
  trackerFromDraft,
  trackerFromReport,
  type ConsentReport,
} from "./consents";
import { ApiError, tokenStore } from "../../lib/api";

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ADA = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const GRACE = "did:key:z6MkwFkMwEJeKXqpUFpqcdUjh7KzDnQPFAgZSjMP9KqYvHeJ";

function roster(): DraftAuthor[] {
  let authors = initialAuthors(ME);
  const ada = addAuthor(authors, ADA, "Ada Lovelace");
  if (!ada.ok) throw new Error(ada.message);
  authors = toggleCreditRole(ada.authors, ada.added.key, "Software");
  return authors;
}

function report(statuses: [string, string][], extra: Partial<ConsentReport> = {}): ConsentReport {
  const authors = statuses.map(([did, status], index) => ({
    did,
    author: did,
    position: index + 1,
    status,
    decision: status === "signed" ? "accept" : status === "declined" ? "decline" : null,
    consentCid: null,
    role: null,
    creditRoles: null,
  }));
  const count = (status: string): number => authors.filter((a) => a.status === status).length;
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiexample",
    state: "awaiting_consent",
    count: authors.length,
    waiting: count("waiting"),
    signed: count("signed"),
    declined: count("declined"),
    authors,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackerFromDraft", () => {
  it("shows every author waiting, with names, identifiers and roles", () => {
    const entries = trackerFromDraft(roster());
    expect(entries.map((e) => [e.name, e.status, e.isYou])).toEqual([
      ["You", "waiting", true],
      ["Ada Lovelace", "waiting", false],
    ]);
    expect(entries[1]).toMatchObject({ monogram: "AL", roles: ["Software"] });
    expect(entries[1].detail).toBe(shortDid(ADA));
    expect(entries[0].detail).toBe(shortDid(ME));
    expect(entries[0].monogram).toBeNull();
  });

  it("does not repeat an identifier that already stands in for the name", () => {
    const added = addAuthor(initialAuthors(ME), "grace@example.org");
    if (!added.ok) throw new Error(added.message);
    const [, grace] = trackerFromDraft(added.authors);
    expect(grace).toMatchObject({ name: "grace@example.org", detail: null, monogram: null });
  });
});

describe("trackerFromReport", () => {
  it("takes who is listed, their order and their status from the node", () => {
    const entries = trackerFromReport(
      report([
        [GRACE, "waiting"],
        [ME, "signed"],
        [ADA, "declined"],
      ]),
      roster(),
    );
    expect(entries.map((e) => [e.key, e.status])).toEqual([
      [GRACE, "waiting"],
      [ME, "signed"],
      [ADA, "declined"],
    ]);
    // Names come from the draft where it knows the DID; otherwise the DID, shortened.
    expect(entries.map((e) => e.name)).toEqual([shortDid(GRACE), "You", "Ada Lovelace"]);
    expect(entries[1].isYou).toBe(true);
  });

  it("puts the author at position 1 first whatever order the list arrives in", () => {
    const shuffled = report([
      [ME, "signed"],
      [ADA, "waiting"],
    ]);
    shuffled.authors.reverse();
    expect(trackerFromReport(shuffled).map((e) => e.key)).toEqual([ME, ADA]);
  });

  it("treats a status it does not know as waiting", () => {
    expect(toConsentStatus("signed")).toBe("signed");
    expect(toConsentStatus("declined")).toBe("declined");
    expect(toConsentStatus("waiting")).toBe("waiting");
    expect(toConsentStatus("revoked")).toBe("waiting");
  });
});

describe("the summary", () => {
  it("counts each status and says what is left", () => {
    const entries = trackerFromReport(
      report([
        [ME, "signed"],
        [ADA, "waiting"],
        [GRACE, "declined"],
      ]),
    );
    expect(countConsents(entries)).toEqual({ total: 3, signed: 1, waiting: 1, declined: 1 });
    expect(consentSummary(countConsents(entries))).toBe("1 of 3 signed · 1 waiting · 1 declined");
    expect(consentSummary({ total: 3, signed: 3, waiting: 0, declined: 0 })).toBe("3 of 3 signed");
  });

  it("names who declined and what that did to the version", () => {
    const one = trackerFromReport(report([[ME, "signed"], [ADA, "declined"]]), roster());
    expect(declineNotice(one)).toBe(
      "Ada Lovelace declined authorship, so this version is back in draft. Talk to them, then submit again.",
    );
    const two = trackerFromReport(report([[ME, "declined"], [ADA, "declined"], [GRACE, "signed"]]), roster());
    expect(declineNotice(two)).toContain("You and Ada Lovelace declined authorship");
    expect(declineNotice(trackerFromReport(report([[ME, "signed"]])))).toBeNull();
  });
});

describe("fetchConsents", () => {
  it("sends the signed-in user's token, since unlisted versions' consents are not public", async () => {
    const body = report([[ME, "signed"]]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    tokenStore.set({ accessToken: "author-token" });
    try {
      await expect(fetchConsents({ paper: "sch:abcd-efgh-ijkl", version: 2 })).resolves.toEqual(body);
    } finally {
      tokenStore.clear();
    }

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/v1/papers/sch%3Aabcd-efgh-ijkl/v/2/consents");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer author-token");
  });

  it("turns a 404 into a sentence about the version, and anything else into 'trying again'", async () => {
    const problem = new ApiError(404, { type: "about:blank", title: "Not Found", status: 404 });
    expect(consentsErrorMessage(problem)).toContain("does not have that version");
    expect(consentsErrorMessage(new Error("boom"))).toBe("Could not check who has signed. Trying again shortly.");
  });
});
