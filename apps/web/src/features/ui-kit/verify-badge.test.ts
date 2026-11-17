import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import * as kit from "./index";
import { VerifyBadge } from "./verify-badge";
import {
  VERIFY_BADGE_SPECS,
  VERIFY_STATES,
  type VerifyState,
} from "./verify";

afterEach(cleanup);

/** Render a badge and hand back its root element. */
function badgeOf(element: ReturnType<typeof createElement>): HTMLElement {
  const { container } = render(element);
  const badge = container.firstElementChild;
  if (!(badge instanceof HTMLElement)) throw new Error("badge did not render");
  return badge;
}

function linkOf(badge: HTMLElement): HTMLAnchorElement {
  const link = badge.querySelector("a");
  if (!(link instanceof HTMLAnchorElement)) throw new Error("badge has no link");
  return link;
}

describe("VerifyBadge", () => {
  it.each(VERIFY_STATES)("%s shows an icon plus its words", (state) => {
    const badge = badgeOf(createElement(VerifyBadge, { state }));
    const icon = badge.querySelector("svg");

    // The words are real text, and the only text: this is the accessible name.
    expect(badge.textContent).toBe(VERIFY_BADGE_SPECS[state].label);
    expect(screen.getByText(VERIFY_BADGE_SPECS[state].label)).toBeTruthy();

    // The icon is drawn, decorative, and not a tab stop.
    expect(icon).not.toBeNull();
    expect(icon?.querySelectorAll("path, circle").length).toBeGreaterThan(0);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
  });

  it("adds a finished check's counts to the indicator, as the PRD's journey 3 reads", () => {
    const badge = badgeOf(
      createElement(VerifyBadge, {
        state: "verified",
        counts: { versions: 3, signatures: 4 },
      }),
    );

    expect(badge.textContent).toBe("Verified · 3 versions · 4 signatures");
    // The link's accessible name is still the visible words.
    expect(
      screen.getByRole("link", { name: "Verified · 3 versions · 4 signatures" }),
    ).toBeTruthy();
    // The state itself is unchanged, so the styling and the live region stay right.
    expect(badge.dataset.state).toBe("verified");
  });

  it("counts a signed but unanchored check the same way, and never a failure", () => {
    expect(
      badgeOf(
        createElement(VerifyBadge, {
          state: "anchor_pending",
          counts: { versions: 2, signatures: 3 },
        }),
      ).textContent,
    ).toBe("Verified · 2 versions · 3 signatures");

    cleanup();
    expect(
      badgeOf(
        createElement(VerifyBadge, {
          state: "failed",
          counts: { versions: 2, signatures: 3 },
        }),
      ).textContent,
    ).toBe("Verification failed");
  });

  it("keeps its own words when the check reported no counts", () => {
    const badge = badgeOf(
      createElement(VerifyBadge, { state: "verified", counts: null }),
    );
    expect(badge.textContent).toBe("Verified");
  });

  it("renders the five labels of docs/design.md §5.3", () => {
    const words = VERIFY_STATES.map(
      (state) => badgeOf(createElement(VerifyBadge, { state })).textContent,
    );
    expect(words).toEqual([
      "Verified",
      "Signed · anchor pending",
      "Checking…",
      "Could not check",
      "Verification failed",
    ]);
  });

  it("gives every state a different icon, so colour is never the only difference", () => {
    const icons = VERIFY_STATES.map(
      (state) =>
        badgeOf(createElement(VerifyBadge, { state })).querySelector("svg")?.innerHTML,
    );
    expect(icons.every((markup) => markup && markup.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(VERIFY_STATES.length);
  });

  it("fills the ◔ wedge and draws every other icon as an outline", () => {
    const fills = VERIFY_STATES.map((state) =>
      [
        ...badgeOf(createElement(VerifyBadge, { state })).querySelectorAll("svg [fill]"),
      ].map((shape) => shape.getAttribute("fill")),
    );
    expect(fills).toEqual([[], ["currentColor"], [], [], []]);
  });

  it("exposes state and colour family as data attributes for styling and tests", () => {
    const expected: Record<VerifyState, string> = {
      verified: "verified",
      anchor_pending: "pending",
      checking: "neutral",
      cannot_verify: "neutral",
      failed: "critical",
    };
    for (const state of VERIFY_STATES) {
      const badge = badgeOf(createElement(VerifyBadge, { state }));
      expect(badge.dataset.state).toBe(state);
      expect(badge.dataset.tone).toBe(expected[state]);
      expect(badge.classList.contains("sch-verify")).toBe(true);
      cleanup();
    }
  });

  it("is a link to the Proof tab: it always opens it", () => {
    for (const state of VERIFY_STATES) {
      const link = linkOf(badgeOf(createElement(VerifyBadge, { state })));
      expect(link.getAttribute("href")).toBe("#proof");
      expect(link.classList.contains("sch-verify__link")).toBe(true);
      cleanup();
    }
  });

  it("is reachable by role and name: the link's name is the visible words", () => {
    render(createElement(VerifyBadge, { state: "anchor_pending" }));
    const link = screen.getByRole("link", { name: "Signed · anchor pending" });
    expect(link.getAttribute("href")).toBe("#proof");
    // Added by the title, never by an aria-label that could drift from the words.
    expect(link.hasAttribute("aria-label")).toBe(false);
  });

  it("describes itself in a tooltip: what the state means, then what a click does", () => {
    for (const state of VERIFY_STATES) {
      const link = linkOf(badgeOf(createElement(VerifyBadge, { state })));
      expect(link.title).toBe(`${VERIFY_BADGE_SPECS[state].meaning} Opens the Proof tab.`);
      cleanup();
    }
  });

  it("points at a given href, trimmed, instead of the default", () => {
    const link = linkOf(
      badgeOf(
        createElement(VerifyBadge, {
          state: "verified",
          href: "  /p/k3f9-q2xz-7mwd/v2#proof ",
        }),
      ),
    );
    expect(link.getAttribute("href")).toBe("/p/k3f9-q2xz-7mwd/v2#proof");
  });

  it("falls back to #proof for a blank href rather than render a dead link", () => {
    for (const href of ["", "   ", undefined, null, 4]) {
      const link = linkOf(
        badgeOf(createElement(VerifyBadge, { state: "verified", href } as never)),
      );
      expect(link.getAttribute("href")).toBe("#proof");
      cleanup();
    }
  });

  it("is a polite live region, so a change from Checking… to a verdict is announced", () => {
    const badge = badgeOf(createElement(VerifyBadge, { state: "checking" }));
    expect(badge.getAttribute("role")).toBe("status");
    expect(screen.getByRole("status").textContent).toBe("Checking…");
    // `status` is implicitly polite and atomic: no aria-live to get wrong.
    expect(badge.hasAttribute("aria-live")).toBe(false);
  });

  it("announces the verdict by changing in place when the state changes", () => {
    const { container, rerender } = render(
      createElement(VerifyBadge, { state: "checking" }),
    );
    const region = container.firstElementChild;
    const link = container.querySelector("a");

    rerender(createElement(VerifyBadge, { state: "verified" }));

    // The same nodes, updated: this is what makes a live region speak.
    expect(container.firstElementChild).toBe(region);
    expect(container.querySelector("a")).toBe(link);
    expect(region?.textContent).toBe("Verified");
    expect((region as HTMLElement).dataset.state).toBe("verified");
    expect((region as HTMLElement).dataset.tone).toBe("verified");
  });

  it("passes className and other span attributes through without losing its own", () => {
    const badge = badgeOf(
      createElement(VerifyBadge, {
        state: "failed",
        className: "ml-2",
        id: "paper-verify",
        "data-testid": "badge",
      } as never),
    );
    expect(badge.className).toBe("sch-verify ml-2");
    expect(badge.id).toBe("paper-verify");
    expect(badge.dataset.testid).toBe("badge");
    expect(badge.dataset.state).toBe("failed");
  });

  it("cannot be made to lie about its state, or stop being a live region, through attributes", () => {
    const badge = badgeOf(
      createElement(VerifyBadge, {
        state: "failed",
        role: "presentation",
        "data-state": "verified",
        "data-tone": "verified",
      } as never),
    );
    expect(badge.getAttribute("role")).toBe("status");
    expect(badge.dataset.state).toBe("failed");
    expect(badge.dataset.tone).toBe("critical");
  });

  it("lets a caller take the click over for a client-side tab switch", () => {
    let defaultPrevented: boolean | undefined;
    const badge = badgeOf(
      createElement(VerifyBadge, {
        state: "verified",
        onClick: (event: { preventDefault: () => void; defaultPrevented: boolean }) => {
          event.preventDefault();
          defaultPrevented = true;
        },
      } as never),
    );
    const notCancelled = fireEvent.click(linkOf(badge));
    expect(defaultPrevented).toBe(true);
    // fireEvent returns false when preventDefault was called.
    expect(notCancelled).toBe(false);
  });

  it("renders nothing for a state outside the five, rather than the wrong words", () => {
    for (const state of [
      "pending",
      "anchor-pending",
      "VERIFIED",
      "",
      undefined,
      null,
      4,
    ]) {
      const { container } = render(createElement(VerifyBadge, { state } as never));
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("renders on the server with the words and the link in the HTML, no client JS needed", () => {
    const html = renderToStaticMarkup(
      createElement(VerifyBadge, { state: "anchor_pending" }),
    );
    expect(html).toContain("Signed · anchor pending");
    expect(html).toContain('data-state="anchor_pending"');
    expect(html).toContain('href="#proof"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<svg");
  });
});

describe("the ui-kit entry point", () => {
  it("exports the badge, its states and its helpers", () => {
    for (const name of [
      "VerifyBadge",
      "VERIFY_STATES",
      "VERIFY_BADGE_SPECS",
      "PROOF_TAB_HREF",
      "isVerifyState",
      "proofTabHref",
      "verifyBadgeTitle",
    ]) {
      expect(name in kit, name).toBe(true);
    }
  });

  it("exports the new verification icons", () => {
    expect(kit.ICON_NAMES).toEqual(
      expect.arrayContaining(["pending", "spinner", "question", "cross"]),
    );
  });
});
