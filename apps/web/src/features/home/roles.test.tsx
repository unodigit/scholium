import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HowItWorksSection } from "./how-it-works";
import { RolesSection } from "./roles";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `hidden` attribute inside a tag (the word "hidden" also appears in the copy). */
const HIDDEN_ATTRIBUTE = /<[a-z][^>]*\shidden(=|\s|\/|>)/i;

const ROLES = [
  { id: "authors", label: "Authors", title: "Publish in minutes. Prove priority for good.", cta: "Submit a paper", href: "/submit" },
  { id: "reviewers", label: "Reviewers", title: "Review anonymously. Stay accountable.", cta: "Find a paper to review", href: "/papers" },
  { id: "readers", label: "Readers", title: "Know what's been checked.", cta: "Browse papers", href: "/papers" },
  { id: "libraries", label: "Libraries", title: "Keep your researchers' work, and prove it.", cta: "See the network", href: "/network" },
] as const;

const tabs = () => screen.getAllByRole("tab");
const tab = (label: string) => screen.getByRole("tab", { name: label });
const panel = (id: string) => document.getElementById(`panel-${id}`) as HTMLElement;

/** Which tab is selected, which one holds the tab stop, and which panels are hidden. */
function snapshot() {
  return {
    selected: tabs().filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent),
    tabStop: tabs().filter((t) => t.tabIndex === 0).map((t) => t.textContent),
    hidden: ROLES.map((r) => panel(r.id).hidden),
  };
}

function expectOnly(label: string) {
  const index = ROLES.findIndex((r) => r.label === label);
  expect(snapshot()).toEqual({
    selected: [label],
    tabStop: [label],
    hidden: ROLES.map((_, i) => i !== index),
  });
  expect(document.activeElement).toBe(tab(label));
}

describe("RolesSection: the server render", () => {
  const html = renderToString(createElement(RolesSection));
  const host = document.createElement("div");
  host.innerHTML = html;

  it("contains all four panels, with the reference copy and none of them hidden", () => {
    const panels = Array.from(host.querySelectorAll('[role="tabpanel"]'));
    expect(panels.map((p) => p.id)).toEqual(ROLES.map((r) => `panel-${r.id}`));
    for (const p of panels) expect(p.hasAttribute("hidden")).toBe(false);
    expect(html).not.toMatch(HIDDEN_ATTRIBUTE);
    for (const role of ROLES) {
      expect(panel_(host, role.id).querySelector("h3")?.textContent).toBe(role.title);
      expect(panel_(host, role.id).querySelectorAll("li")).toHaveLength(4);
    }
    expect(html).toContain("Planned: independent library nodes and public timestamp anchoring.");
    expect(html).toContain("sch:k3f9-q2xz-7mwd");
  });

  it("checks for the hidden attribute in a way that can fail", () => {
    expect(HIDDEN_ATTRIBUTE.test('<div class="panel" role="tabpanel" hidden="">')).toBe(true);
    expect(HIDDEN_ATTRIBUTE.test('<div class="panel" hidden>')).toBe(true);
    expect(HIDDEN_ATTRIBUTE.test('<span aria-hidden="true"></span>')).toBe(false);
    expect(HIDDEN_ATTRIBUTE.test("<p>Your name can stay hidden from the authors</p>")).toBe(false);
    expect(html).toContain("Your name can stay hidden from the authors");
  });

  it("renders the four tabs with the first selected and the roving tab stop on it", () => {
    const rendered = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(rendered.map((t) => t.textContent)).toEqual(["Authors", "Reviewers", "Readers", "Libraries"]);
    expect(rendered.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(rendered.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
  });

  it("names the section, the tablist and the eyebrow", () => {
    expect(host.querySelector("section#who")?.getAttribute("aria-labelledby")).toBe("who-title");
    expect(host.querySelector("h2#who-title")?.textContent).toBe("Built for everyone who touches a paper.");
    expect(host.querySelector(".eyebrow")?.textContent).toBe("Who it's for");
    expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Choose your role");
  });
});

function panel_(root: ParentNode, id: string): HTMLElement {
  return root.querySelector(`#panel-${id}`) as HTMLElement;
}

describe("RolesSection: hydration", () => {
  it("leaves all four panels in the markup until client code hides the inactive three", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(RolesSection));
    document.body.appendChild(container);
    expect(Array.from(container.querySelectorAll('[role="tabpanel"]')).map((p) => (p as HTMLElement).hidden)).toEqual([
      false, false, false, false,
    ]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(createElement(RolesSection), { container, hydrate: true });

    expect(errors).not.toHaveBeenCalled();
    expect(snapshot()).toEqual({
      selected: ["Authors"],
      tabStop: ["Authors"],
      hidden: [false, true, true, true],
    });
    container.remove();
  });
});

describe("RolesSection: tabs", () => {
  beforeEach(() => {
    render(createElement(RolesSection));
  });

  it("starts on Authors: aria-selected, roving tabindex and hidden panels on the client", () => {
    expect(snapshot()).toEqual({
      selected: ["Authors"],
      tabStop: ["Authors"],
      hidden: [false, true, true, true],
    });
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(4);
  });

  it("wires every tab to its panel and every panel back to its tab", () => {
    for (const role of ROLES) {
      expect(tab(role.label).id).toBe(`tab-${role.id}`);
      expect(tab(role.label).getAttribute("aria-controls")).toBe(`panel-${role.id}`);
      expect(panel(role.id).getAttribute("aria-labelledby")).toBe(`tab-${role.id}`);
    }
    for (const t of tabs()) expect(t.getAttribute("type")).toBe("button");
  });

  it("selects a tab on click and shows only its panel", () => {
    fireEvent.click(tab("Readers"));
    expect(snapshot()).toEqual({
      selected: ["Readers"],
      tabStop: ["Readers"],
      hidden: [true, true, false, true],
    });
    expect(screen.getByRole("tabpanel")).toBe(panel("readers"));
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { level: 3 }).textContent).toBe(
      "Know what's been checked.",
    );
  });

  it("moves focus and selection with Arrow Right, wrapping from the last tab to the first", () => {
    tab("Authors").focus();
    for (const label of ["Reviewers", "Readers", "Libraries", "Authors"]) {
      const handled = !fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
      expect(handled).toBe(true);
      expectOnly(label);
    }
  });

  it("moves focus and selection with Arrow Left, wrapping from the first tab to the last", () => {
    tab("Authors").focus();
    for (const label of ["Libraries", "Readers", "Reviewers", "Authors"]) {
      fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
      expectOnly(label);
    }
  });

  it("jumps to the last tab with End and the first with Home", () => {
    tab("Authors").focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expectOnly("Libraries");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expectOnly("Authors");
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expectOnly("Authors");
  });

  it("starts from the tab that has focus, not from the first", () => {
    fireEvent.click(tab("Readers"));
    tab("Readers").focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expectOnly("Reviewers");
  });

  it("leaves other keys and modified arrows to the browser", () => {
    tab("Authors").focus();
    for (const init of [
      { key: "ArrowDown" },
      { key: "ArrowUp" },
      { key: "Tab" },
      { key: "a" },
      { key: "ArrowRight", altKey: true },
      { key: "ArrowLeft", metaKey: true },
      { key: "ArrowRight", ctrlKey: true },
    ]) {
      const untouched = fireEvent.keyDown(document.activeElement as Element, init);
      expect(untouched, JSON.stringify(init)).toBe(true);
      expectOnly("Authors");
    }
  });

  it.each(ROLES)("$label panel: CTA \"$cta\" goes to $href", ({ id, cta, href }) => {
    const link = panel(id).querySelector("a.btn-filled") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(href);
    expect(link.textContent?.trim()).toBe(cta);
    expect(panel(id).querySelectorAll("a")).toHaveLength(1);
  });

  it("links the visible panel's CTA once its tab is selected", () => {
    const hrefs: (string | null)[] = [];
    for (const role of ROLES) {
      fireEvent.click(tab(role.label));
      hrefs.push(within(screen.getByRole("tabpanel")).getByRole("link").getAttribute("href"));
    }
    expect(hrefs).toEqual(["/submit", "/papers", "/papers", "/network"]);
  });

  it("marks the panel that just opened so it can ease in, but not the first one on load", () => {
    expect(panel("authors").classList.contains("entering")).toBe(false);
    fireEvent.click(tab("Libraries"));
    expect(panel("libraries").classList.contains("entering")).toBe(true);
    expect(panel("authors").classList.contains("entering")).toBe(false);
  });
});

/* ---- The indicator -------------------------------------------------------------
   jsdom has no layout, so the tabs' geometry is stubbed: four tabs, the last one
   wider. Frames are driven by hand. */
describe("RolesSection: the sliding indicator", () => {
  const LEFTS = [4, 104, 214, 314];
  const WIDTHS = [100, 110, 100, 120];
  const descriptors: Record<string, PropertyDescriptor | undefined> = {};
  let frames: FrameRequestCallback[] = [];

  const indexOf = (el: HTMLElement) =>
    el.getAttribute("role") === "tab"
      ? Array.from(el.parentElement?.querySelectorAll('[role="tab"]') ?? []).indexOf(el)
      : -1;

  const run = (count: number) => {
    const t0 = performance.now();
    for (let k = 1; k <= count; k += 1) {
      const batch = frames;
      frames = [];
      for (const callback of batch) callback(t0 + k * 16);
    }
  };
  const indicator = () => document.querySelector(".seg-ind") as HTMLElement;
  const translate = () => Number(/translateX\(([-\d.e]+)px\)/.exec(indicator().style.transform)?.[1]);

  beforeEach(() => {
    for (const [prop, values] of [["offsetLeft", LEFTS], ["offsetWidth", WIDTHS]] as const) {
      descriptors[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          const i = indexOf(this);
          return i < 0 ? 0 : values[i];
        },
      });
    }
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
  });

  afterEach(() => {
    for (const [prop, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    }
  });

  it("starts under the first tab, hidden from assistive technology", () => {
    render(createElement(RolesSection));
    expect(indicator().getAttribute("aria-hidden")).toBe("true");
    expect(indicator().style.width).toBe("100px");
    expect(indicator().style.transform).toBe("translateX(4px) scaleX(1)");
    expect(frames).toHaveLength(0);
  });

  it("slides and resizes to the selected tab on a spring, then settles exactly on it", () => {
    render(createElement(RolesSection));
    fireEvent.click(tab("Libraries"));

    // Nothing has moved until the first frame; then it eases out of the start.
    expect(indicator().style.transform).toBe("translateX(4px) scaleX(1)");
    run(1);
    expect(translate()).toBeGreaterThan(4);
    expect(translate()).toBeLessThan(314);
    const scale = Number(/scaleX\(([-\d.e]+)\)/.exec(indicator().style.transform)?.[1]);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(1.25);

    run(120);
    expect(indicator().style.transform).toBe("translateX(314px) scaleX(1.2)");
    expect(frames).toHaveLength(0);
  });

  it("can be redirected mid-flight and still lands on the new tab", () => {
    render(createElement(RolesSection));
    fireEvent.click(tab("Libraries"));
    run(6);
    const midway = translate();
    expect(midway).toBeGreaterThan(4);
    fireEvent.click(tab("Readers"));
    run(150);
    expect(indicator().style.transform).toBe("translateX(214px) scaleX(1)");
    expect(frames).toHaveLength(0);
  });

  it("follows the keyboard as well as the pointer", () => {
    render(createElement(RolesSection));
    tab("Authors").focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    run(120);
    expect(indicator().style.transform).toBe("translateX(314px) scaleX(1.2)");
  });

  it("jumps instead of gliding when the reader prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(createElement(RolesSection));
    fireEvent.click(tab("Readers"));
    expect(indicator().style.transform).toBe("translateX(214px) scaleX(1)");
    fireEvent.click(tab("Libraries"));
    expect(indicator().style.width).toBe("120px");
    expect(indicator().style.transform).toBe("translateX(314px) scaleX(1)");
    expect(frames).toHaveLength(0);
  });
});

describe("HowItWorksSection", () => {
  const STEPS = [
    ["Sign in", "Create a passkey and link your ORCID iD. It takes about a minute, and there is no password."],
    ["Submit", "Upload your PDF or LaTeX. Your browser fingerprints and signs it, and your co-authors add their consent."],
    ["Get listed", "A volunteer moderator checks it against public policy, aiming to decide within 48 hours. Every decision is a signed record."],
    ["Gather the margin", "AI pre-review, formal reviews and discussion collect beside the text, version by version."],
  ];

  it("is the #how section with its eyebrow and title", () => {
    const { container } = render(createElement(HowItWorksSection));
    expect(container.querySelector("section#how")?.getAttribute("aria-labelledby")).toBe("how-title");
    expect(container.querySelector(".eyebrow")?.textContent).toBe("How it works");
    expect(screen.getByRole("heading", { level: 2, name: "From draft to discussed, in four steps." }).id).toBe(
      "how-title",
    );
  });

  it("shows the four numbered steps in order", () => {
    const { container } = render(createElement(HowItWorksSection));
    const items = Array.from(container.querySelectorAll("ol.steps > li.step"));
    expect(items).toHaveLength(4);
    expect(items.map((li) => [li.querySelector("h3")?.textContent, li.querySelector("p")?.textContent])).toEqual(STEPS);
    expect(items.map((li) => li.querySelector(".step-n")?.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(items.map((li) => (li as HTMLElement).style.getPropertyValue("--k"))).toEqual(["0", "1", "2", "3"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("draws a connector after each step, kept out of the accessibility tree", () => {
    const { container } = render(createElement(HowItWorksSection));
    const lines = Array.from(container.querySelectorAll(".step-line"));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.getAttribute("aria-hidden")).toBe("true");
    for (const n of Array.from(container.querySelectorAll(".step-n"))) expect(n.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals the list on scroll and has every word in the server HTML", () => {
    const html = renderToString(createElement(HowItWorksSection));
    expect(html).toContain("steps-reveal");
    for (const [title, text] of STEPS) {
      expect(html).toContain(title);
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(HIDDEN_ATTRIBUTE);
  });
});
