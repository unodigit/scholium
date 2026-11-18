import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDate, formatDateTime, toDate } from "./format-date";
import { LocalDate } from "./local-date";

// The feature-level formatters, for the cross-page agreement test below.
import { formatDate as discussionDate } from "../paper-discussion/discussion";
import { formatDate as consoleDate } from "../mod-console/wire";
import { formatDate as feedDate } from "../feed/feed";
import { formatEndorsementDate as endorseDate } from "../dashboard/endorse";
import {
  formatReviewDate as reviewDate,
  reportGateDate as reportGate,
} from "../paper-reviews/review";
import { formatRevealDate as revealDate, revealDateFor } from "../review-form/commit";
import { formatListedAt as searchDate } from "../search-page/search";
import { formatDate as metaDate } from "../paper-meta/meta";
import { incidentDate } from "../network-page/network";
import { formatRemovalDate as removalDate } from "../paper-page/unlisted-paper";
import { formatSigned as consentDate } from "../submit/consent-version";

/**
 * One date format for the whole product, in the reader's own time zone
 * (bug_spec_verify6 bug 4). An action taken at 00:45 on 18 November in AEDT is
 * still 17 November in UTC; before this module every page formatted in UTC, so
 * the consent page, the appeal banner, review cards, discussion posts and the
 * version list all named the previous day to a reader east of UTC.
 *
 * `Australia/Sydney` is passed explicitly because that is the zone the
 * journeys ran in (UTC+11 in November); the default is the reader's zone.
 */

// Run in the journeys' zone (UTC+11 in November) whatever zone the suite is
// started in: the reader's-zone defaults below must be as deterministic as the
// named zones are, and a UTC runner would otherwise hide the zone-less parse
// this file guards (below). Vitest isolates each file in its own process, so
// the pin cannot reach another test file.
process.env.TZ = "Australia/Sydney";

/** 00:45 on 18 Nov 2026 in Sydney; 13:45 on 17 Nov in UTC. */
const NEAR_MIDNIGHT = "2026-11-17T13:45:00Z";

/** The date `formatDate` should write with no explicit zone: the reader's. */
function localDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("formatDate", () => {
  it("writes the calendar date in the reader's zone, not the UTC date", () => {
    expect(formatDate(NEAR_MIDNIGHT, { timeZone: "Australia/Sydney" })).toBe(
      "18 Nov 2026",
    );
    expect(formatDate(NEAR_MIDNIGHT, { timeZone: "UTC" })).toBe("17 Nov 2026");
    // The reader's own zone is the default: no zone is the browser's, which
    // is what makes the same instant read the same on every page.
    expect(formatDate(NEAR_MIDNIGHT)).toBe(localDate(NEAR_MIDNIGHT));
  });

  it("can write the long month moderation copy uses", () => {
    expect(
      formatDate(NEAR_MIDNIGHT, { timeZone: "Australia/Sydney", month: "long" }),
    ).toBe("18 November 2026");
  });

  it("says nothing for a value that is not a date", () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDate("not a date")).toBeNull();
  });
});

describe("a timestamp without a zone designator", () => {
  // The API writes UTC instants with no zone: `"revealed_at":
  // "2026-11-18T04:53:41"`. `new Date` reads such a string in the runtime's
  // own zone (ECMA-262: no offset means local time), so a reader east of UTC
  // was told an instant happened up to a day before it did — the review page
  // dated a reveal one day early (04:53 UTC on 18 Nov read as 17 Nov 17:53
  // UTC in Sydney, then printed as the UTC day). The helper names the zone
  // the API means before it formats.
  const ZONELESS = "2026-11-18T04:53:41";

  it("is parsed as UTC — the API's convention — not as the runtime's zone", () => {
    expect(toDate(ZONELESS)?.toISOString()).toBe("2026-11-18T04:53:41.000Z");
  });

  it("is shown in the reader's zone from that UTC instant", () => {
    // 04:53 UTC is 15:53 the same 18 November in Sydney.
    expect(formatDate(ZONELESS)).toBe("18 Nov 2026");
    expect(formatDateTime(ZONELESS)).toMatch(/^18 Nov 2026 15:53 /);
    expect(formatDate(ZONELESS, { timeZone: "UTC" })).toBe("18 Nov 2026");
  });

  it("writes the day the paper page writes for the same instant", () => {
    expect(formatDate(ZONELESS, { timeZone: "Australia/Sydney" })).toBe(
      formatDate("2026-11-18T04:53:41Z", { timeZone: "Australia/Sydney" }),
    );
  });

  it("leaves a timestamp that already names its zone alone", () => {
    expect(toDate("2026-11-18T04:53:41Z")?.toISOString()).toBe(
      "2026-11-18T04:53:41.000Z",
    );
    expect(toDate("2026-11-17T21:53:41-07:00")?.toISOString()).toBe(
      "2026-11-18T04:53:41.000Z",
    );
    expect(formatDate("2026-11-18T15:53:41+11:00")).toBe("18 Nov 2026");
  });
});

describe("formatDateTime", () => {
  it("writes the local date and time, and the UTC instant on request", () => {
    expect(
      formatDateTime(NEAR_MIDNIGHT, { timeZone: "Australia/Sydney" }),
    ).toMatch(/^18 Nov 2026 00:45 /);
    expect(formatDateTime(NEAR_MIDNIGHT, { timeZone: "UTC" })).toBe(
      "17 Nov 2026 13:45 UTC",
    );
  });

  it("says nothing for a value that is not a date", () => {
    expect(formatDateTime(null)).toBeNull();
    expect(formatDateTime("not a date")).toBeNull();
  });
});

describe("LocalDate", () => {
  it("renders a <time> with the instant and the UTC instant as its title", () => {
    const markup = renderToStaticMarkup(
      createElement(LocalDate, { value: NEAR_MIDNIGHT }),
    );
    // Parse the way a browser parses the server's HTML (attribute names are
    // case-insensitive) rather than comparing React's markup spelling.
    const container = document.createElement("div");
    container.innerHTML = markup;
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(NEAR_MIDNIGHT);
    expect(time?.getAttribute("title")).toBe("17 Nov 2026 13:45 UTC");
    // On the server the zone is the server's, so the stable UTC date is the
    // one in the first HTML; the browser replaces it with the reader's below.
    expect(time?.textContent).toBe("17 Nov 2026");
  });

  it("hydrates the server HTML without a mismatch warning, then shows the reader's date", () => {
    const html = renderToStaticMarkup(
      createElement(LocalDate, { value: NEAR_MIDNIGHT }),
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(createElement(LocalDate, { value: NEAR_MIDNIGHT }), {
      container,
      hydrate: true,
    });

    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector("time")?.textContent).toBe(
      localDate(NEAR_MIDNIGHT),
    );
    // In Sydney that is the 18th: the day the reader acted.
    if (localDate(NEAR_MIDNIGHT) !== "17 Nov 2026") {
      expect(container.querySelector("time")?.textContent).not.toBe("17 Nov 2026");
    }
    container.remove();
  });

  it("can write the long month the site's prose uses", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(LocalDate, { value: NEAR_MIDNIGHT, month: "long" }),
    );
    // The first HTML is the stable UTC form; the reader's browser replaces it
    // with the long-month local date, exactly as the short form does.
    expect(container.querySelector("time")?.textContent).toBe("17 November 2026");
    document.body.append(container);
    const local = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(NEAR_MIDNIGHT));
    render(createElement(LocalDate, { value: NEAR_MIDNIGHT, month: "long" }), {
      container,
      hydrate: true,
    });
    expect(container.querySelector("time")?.textContent).toBe(local);
    container.remove();
  });

  it("renders nothing for a value that is not a date", () => {
    expect(
      renderToStaticMarkup(createElement(LocalDate, { value: "not a date" })),
    ).toBe("");
    expect(
      renderToStaticMarkup(createElement(LocalDate, { value: null })),
    ).toBe("");
  });
});

describe("every page names the same day for the same instant", () => {
  // bug_spec_verify12 bug 2: each feature used to format in UTC on its own, so
  // one instant dated the 18th on the discussion and the 17th on the feed.
  // These are the real module-level formatters, not the shared helper they all
  // delegate to, so a regression in any one of them fails here.
  const NEAR_MIDNIGHT_LOCAL = "2026-11-17T13:45:00Z"; // 18 Nov in Sydney

  it("writes the reader's day from each feature's formatter", () => {
    expect(discussionDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(consoleDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(feedDate(new Date(NEAR_MIDNIGHT_LOCAL))).toBe("18 Nov 2026");
    expect(endorseDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(reviewDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(searchDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(metaDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    expect(consentDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov 2026");
    // The long-month pages say the same day with a longer word.
    expect(incidentDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 November 2026");
    expect(removalDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 November 2026");
    // The short design form drops only the year.
    expect(revealDate(NEAR_MIDNIGHT_LOCAL)).toBe("18 Nov");
  });

  it("agrees on the report-gate day between the form and the public page", () => {
    const commit = "2026-11-17T13:45:00Z";
    // `revealDateFor` adds the window to the instant; the public page must
    // name that instant's day, never a truncated UTC day.
    expect(reportGate([{ committedAt: commit, version: 2 }], 2)).toBe(
      formatDate(revealDateFor(commit)),
    );
  });
});

describe("the server/client boundary", () => {
  // `next build` refuses a module that imports a React hook when a server
  // component's imports reach it, and vitest does not enforce that boundary: the
  // production build once failed with these two in one file (the not-found page of
  // a paper reaches `formatDate`).  The hook lives in `local-date.ts`, a client
  // module, so the functions stay importable from server code.
  const read = (name: string): string =>
    readFileSync(new URL(name, import.meta.url), "utf8");

  it("keeps the formatting functions free of React, so server components can import them", () => {
    expect(read("./format-date.ts")).not.toMatch(/from\s+["']react["']/);
  });

  it("marks the component that uses a hook as a client module", () => {
    expect(read("./local-date.ts").trimStart()).toMatch(/^"use client";/);
  });
});
