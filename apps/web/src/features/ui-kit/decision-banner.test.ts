import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as kit from "./index";
import { DecisionBanner } from "./decision-banner";
import {
  DECISION_BANNER_SPECS,
  DECISION_KINDS,
  decisionDetail,
  type DecisionKind,
} from "./decision";

afterEach(cleanup);

const CID = "bafyreihbppt2cuitohaqvn5j2xz6qk5e4h5f2n7hs3w6m4a5g2t2xw3y4z5a";

const RECORD = {
  v: 1,
  type: "retraction",
  author: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
  created: "2027-05-04T09:12:00Z",
  prev: null,
  body: {
    target: "sch:k3f9-q2xz-7mwd/v2",
    reason: "The results in Figure 3 cannot be reproduced.",
    replacement: null,
  },
  proofs: [],
  id: CID,
};

const loader = vi.fn(async () => RECORD);

/** Render a banner and hand back its root element. */
function bannerOf(props: Record<string, unknown>): HTMLElement {
  const { container } = render(createElement(DecisionBanner, props as never));
  const banner = container.firstElementChild;
  if (!(banner instanceof HTMLElement)) throw new Error("banner did not render");
  return banner;
}

describe("DecisionBanner", () => {
  it.each(DECISION_KINDS)("%s shows an icon, its word and a sentence", (kind) => {
    const banner = bannerOf({ kind, recordCid: CID, loadRecord: loader });
    const icon = banner.querySelector("svg");

    expect(banner.textContent).toContain(DECISION_BANNER_SPECS[kind].label);
    expect(banner.textContent).toContain(decisionDetail(kind));

    expect(icon).not.toBeNull();
    expect(icon?.querySelectorAll("path, circle").length).toBeGreaterThan(0);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
  });

  it("renders each kind's word", () => {
    const labels = [
      "Retracted",
      "Corrected",
      "Withdrawn by the authors",
      "A newer version exists",
      "Content removed for legal reasons",
    ];
    DECISION_KINDS.forEach((kind, index) => {
      expect(bannerOf({ kind, recordCid: CID }).textContent).toContain(labels[index]);
      cleanup();
    });
  });

  it("gives every kind a different icon, so colour is never the only difference", () => {
    const icons = DECISION_KINDS.map(
      (kind) => bannerOf({ kind, recordCid: CID }).querySelector("svg")?.innerHTML,
    );
    expect(icons.every((markup) => markup && markup.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(DECISION_KINDS.length);
  });

  it("exposes kind and colour family as data attributes for styling and tests", () => {
    const banner = bannerOf({ kind: "retracted", recordCid: CID });
    expect(banner.dataset.kind).toBe("retracted");
    expect(banner.dataset.tone).toBe("critical");
    expect(banner.classList.contains("sch-decision")).toBe(true);
    expect(
      bannerOf({ kind: "removed_legal", recordCid: CID }).dataset.tone,
    ).toBe("neutral");
  });

  it("is ordinary content: no role, no live region, no tab stop", () => {
    const banner = bannerOf({ kind: "corrected", recordCid: CID });
    expect(banner.tagName).toBe("DIV");
    expect(banner.hasAttribute("role")).toBe(false);
    expect(banner.hasAttribute("tabindex")).toBe(false);
  });
});

describe("DecisionBanner links to the record", () => {
  it("shows the View record link for the given cid", () => {
    render(
      createElement(DecisionBanner, { kind: "retracted", recordCid: CID, loadRecord: loader }),
    );
    const trigger = screen.getByRole("button", { name: "View record" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("reads exactly the given record when the link is used", async () => {
    const loadRecord = vi.fn(async (_cid: string) => RECORD);
    render(
      createElement(DecisionBanner, { kind: "retracted", recordCid: CID, loadRecord }),
    );
    fireEvent.click(screen.getByRole("button", { name: "View record" }));
    await waitFor(() => expect(loadRecord).toHaveBeenCalled());
    expect(loadRecord.mock.calls[0][0]).toBe(CID);
  });

  it("renders nothing when there is no record behind the decision", () => {
    for (const recordCid of ["", "   ", undefined, null, 42]) {
      const { container } = render(
        createElement(DecisionBanner, { kind: "retracted", recordCid } as never),
      );
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("renders nothing for a kind outside the known kinds", () => {
    for (const kind of ["withdrawal", "", "newer-version", undefined, null, 3]) {
      const { container } = render(
        createElement(DecisionBanner, { kind, recordCid: CID } as never),
      );
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });
});

describe("DecisionBanner links to the policy clause", () => {
  it("cites the clause through the policies page's anchor", () => {
    const banner = bannerOf({ kind: "removed_legal", recordCid: CID, clause: "MOD-05" });
    const policy = banner.querySelector("a.sch-decision__policy");
    expect(policy?.getAttribute("href")).toBe("/policies#MOD-05");
    expect(policy?.textContent).toBe("Policy MOD-05");
  });

  it("shows no policy link when the decision cites no clause", () => {
    const banner = bannerOf({ kind: "retracted", recordCid: CID });
    expect(banner.querySelector("a.sch-decision__policy")).toBeNull();
    expect(screen.getByRole("button", { name: "View record" })).toBeTruthy();
  });

  it("omits a blank clause rather than linking at the page itself", () => {
    for (const clause of ["", "   "]) {
      const banner = bannerOf({ kind: "corrected", recordCid: CID, clause });
      expect(banner.querySelector("a.sch-decision__policy")).toBeNull();
      cleanup();
    }
  });
});

describe("DecisionBanner links to the newer version", () => {
  it("offers the newer version before the record", () => {
    const banner = bannerOf({
      kind: "newer_version",
      recordCid: CID,
      versionHref: "/papers/sch:9f2c1a7e/v3",
      versionLabel: "v3",
    });
    const links = banner.querySelectorAll(".sch-decision__links > *");
    expect(links[0].textContent).toBe("Go to v3");
    expect(
      (links[0] as HTMLAnchorElement).getAttribute("href"),
    ).toBe("/papers/sch:9f2c1a7e/v3");
    expect(links[1].textContent).toBe("View record");
  });

  it("names the newest version generically when it has no label", () => {
    const banner = bannerOf({
      kind: "newer_version",
      recordCid: CID,
      versionHref: "/papers/sch:9f2c1a7e",
    });
    expect(banner.querySelector("a.sch-decision__version")?.textContent).toBe(
      "Go to the newest version",
    );
  });

  it("shows no version link when it has nowhere to point", () => {
    const banner = bannerOf({ kind: "newer_version", recordCid: CID, versionLabel: "v3" });
    expect(banner.querySelector("a.sch-decision__version")).toBeNull();
  });

  it("ignores version links on every other kind", () => {
    for (const kind of ["retracted", "corrected", "removed_legal"] as const) {
      const banner = bannerOf({
        kind,
        recordCid: CID,
        versionHref: "/papers/sch:9f2c1a7e/v3",
        versionLabel: "v3",
      });
      expect(banner.querySelector("a.sch-decision__version")).toBeNull();
      cleanup();
    }
  });
});

describe("DecisionBanner sentences", () => {
  it("shows the decision's own reason as its sentence", () => {
    const banner = bannerOf({
      kind: "retracted",
      recordCid: CID,
      reason: RECORD.body.reason,
    });
    expect(banner.textContent).toContain(RECORD.body.reason);
  });

  it("carries the removal date, the category and the closing sentence", () => {
    const banner = bannerOf({
      kind: "removed_legal",
      recordCid: CID,
      removedOn: "4 May 2027",
      category: "Unlawful content",
    });
    expect(banner.textContent).toContain("Removed on 4 May 2027 · Unlawful content.");
    expect(banner.textContent).toContain("The record of its existence remains.");
  });
});

describe("DecisionBanner plumbing", () => {
  it("passes className and other div attributes through without losing its own", () => {
    const banner = bannerOf({
      kind: "corrected",
      recordCid: CID,
      className: "mt-4",
      id: "paper-decision",
      "data-testid": "banner",
    } as never);
    expect(banner.className).toBe("sch-decision mt-4");
    expect(banner.id).toBe("paper-decision");
    expect(banner.dataset.testid).toBe("banner");
    expect(banner.dataset.kind).toBe("corrected");
  });

  it("cannot be made to lie about its kind through passed attributes", () => {
    const banner = bannerOf({
      kind: "corrected",
      recordCid: CID,
      "data-kind": "retracted",
      "data-tone": "critical",
    } as never);
    expect(banner.dataset.kind).toBe("corrected");
    expect(banner.dataset.tone).toBe("pending");
  });

  it("renders on the server with the word and both links in the HTML", () => {
    const html = renderToStaticMarkup(
      createElement(DecisionBanner, {
        kind: "retracted",
        recordCid: CID,
        clause: "MOD-03",
      }),
    );
    expect(html).toContain("Retracted");
    expect(html).toContain("A retraction notice is on record.");
    expect(html).toContain("View record");
    expect(html).toContain('href="/policies#MOD-03"');
    expect(html).toContain("<svg");
    expect(html).toContain('data-tone="critical"');
  });
});

describe("the ui-kit entry point", () => {
  it("exports the banner and the decision helpers", () => {
    for (const name of [
      "DecisionBanner",
      "DECISION_KINDS",
      "DECISION_BANNER_SPECS",
      "isDecisionKind",
      "decisionDetail",
      "decisionPolicyLabel",
      "decisionVersionLabel",
      "normalizeClauseId",
    ]) {
      expect(kit, `missing export ${name}`).toHaveProperty(name);
    }
  });

  it("documents every kind with a spec", () => {
    for (const kind of DECISION_KINDS as readonly DecisionKind[]) {
      expect(DECISION_BANNER_SPECS[kind].label.length).toBeGreaterThan(0);
      expect(DECISION_BANNER_SPECS[kind].meaning.length).toBeGreaterThan(0);
    }
  });
});
