import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDate, formatDate, formatDateTime } from "./format-date";

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

  it("renders nothing for a value that is not a date", () => {
    expect(
      renderToStaticMarkup(createElement(LocalDate, { value: "not a date" })),
    ).toBe("");
    expect(
      renderToStaticMarkup(createElement(LocalDate, { value: null })),
    ).toBe("");
  });
});
