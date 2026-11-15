// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MARGIN_BODY_ID,
  MARGIN_TOGGLE_LABEL,
  MarginDrawer,
} from "./margin-drawer";

/**
 * The frame around the margin panel (docs/design.md §5.2, §10): a collapsible
 * drawer from 1024 to 1279 px and a bottom sheet under 1024 px.
 *
 * Which of the two it is, is the stylesheet's call (`paper-page.css.test.ts`
 * pins that); jsdom has no layout and no media queries. These tests are about
 * what the component owns: that the server's HTML has nothing to collapse, that
 * the toggle says what state it is in, that collapsing keeps the panel's state,
 * and that the address can open and close it.
 */

/** A stand-in for the margin panel with something in it that has state. */
function Panel() {
  return (
    <div role="tablist" aria-label="Margin of the paper">
      <textarea aria-label="Reply" />
    </div>
  );
}

const toggle = (): HTMLElement =>
  screen.getByRole("button", { name: MARGIN_TOGGLE_LABEL });

const margin = (): HTMLElement =>
  screen.getByRole("complementary", { name: "Margin of the paper" });

beforeEach(() => {
  window.history.replaceState(null, "", "/p/6sel-2dio-orm6");
});

afterEach(cleanup);

describe("before the page runs (the server's HTML)", () => {
  const html = () =>
    renderToStaticMarkup(
      <MarginDrawer>
        <p>Reviewer A</p>
      </MarginDrawer>,
    );

  it("has the panel's content in it, so it reads without JavaScript", () => {
    expect(html()).toContain("Reviewer A");
    expect(html()).toContain('id="' + MARGIN_BODY_ID + '"');
  });

  it("has no toggle, because nothing can collapse without JavaScript", () => {
    expect(html()).not.toContain("<button");
    expect(html()).not.toContain("ppg-margin-toggle");
  });

  it("is not marked as enhanced, so the drawer and sheet styles do not apply", () => {
    expect(html()).not.toContain("data-enhanced");
  });

  it("is still the labelled aside beside the paper", () => {
    expect(html()).toMatch(/<aside[^>]*aria-label="Margin of the paper"/);
  });
});

describe("once the page runs", () => {
  it("is marked as enhanced and offers one toggle", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    expect(margin().getAttribute("data-enhanced")).toBe("true");
    expect(screen.getAllByRole("button", { name: MARGIN_TOGGLE_LABEL })).toHaveLength(1);
  });

  it("starts collapsed, so the paper has the screen", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(margin().getAttribute("data-open")).toBe("false");
  });

  it("names its toggle for what it is, and points it at the panel's body", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    const body = document.getElementById(toggle().getAttribute("aria-controls") ?? "");
    expect(body?.id).toBe(MARGIN_BODY_ID);
    expect(body?.contains(screen.getByRole("tablist"))).toBe(true);
    // The hint beside the name is decoration: it is not part of the name.
    expect(toggle().textContent).toContain("Reviews, discussion, proof");
    expect(toggle().querySelector(".ppg-margin-toggle-hint")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("is a real button that does not submit anything", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("type")).toBe("button");
  });

  it("keeps the arrow decorative: the state is aria-expanded", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    const arrow = toggle().querySelector("svg");
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
    expect(arrow?.getAttribute("focusable")).toBe("false");
  });
});

describe("the toggle", () => {
  it("opens the panel and closes it again, saying which in aria-expanded and data-open", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(margin().getAttribute("data-open")).toBe("true");

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(margin().getAttribute("data-open")).toBe("false");
  });

  it("is reachable by keyboard: Enter and Space are the button's own", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    toggle().focus();
    expect(document.activeElement).toBe(toggle());
    expect(toggle().tabIndex).toBe(0);
  });

  it("leaves the address alone: opening the panel is not a new page", () => {
    const before = window.history.length;
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(window.history.length).toBe(before);
    expect(window.location.hash).toBe("");
  });
});

describe("collapsing", () => {
  it("keeps the panel mounted, so a half-written reply survives", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    fireEvent.click(toggle());

    const reply = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    fireEvent.change(reply, { target: { value: "Thanks. The baseline is in 3.2." } });

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    const after = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    expect(after).toBe(reply);
    expect(after.value).toBe("Thanks. The baseline is in 3.2.");
  });

  it("keeps the panel in the document while collapsed: the stylesheet takes it out of the page", () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    // Present, not `hidden`: the beside-the-paper layout (from 1280 px) shows it
    // whatever the open state is, so only CSS may hide it, and only below that.
    expect(document.getElementById(MARGIN_BODY_ID)).not.toBeNull();
    expect(document.getElementById(MARGIN_BODY_ID)?.hasAttribute("hidden")).toBe(false);
    expect(screen.queryByRole("tablist", { hidden: true })).not.toBeNull();
  });
});

describe("the address", () => {
  it("opens the panel for an address that names a tab, so the link does not land in a closed drawer", () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#files");

    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["reviews", "ai", "discussion", "versions", "files", "proof"])(
    "opens for #%s",
    (name) => {
      window.history.replaceState(null, "", `/p/6sel-2dio-orm6#${name}`);

      render(
        <MarginDrawer>
          <Panel />
        </MarginDrawer>,
      );

      expect(margin().getAttribute("data-open")).toBe("true");
    },
  );

  it("opens when a link to a tab is followed while the page is open", async () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    act(() => {
      window.location.hash = "#proof";
    });

    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("true"));
  });

  it("stays collapsed on arrival with no fragment, or one that is not a tab", () => {
    const { unmount } = render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    unmount();

    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#p-abc123");
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("puts the panel away when the address moves to the paper, so what was asked for is not behind it", async () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#proof");
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    act(() => {
      window.location.hash = "#reading";
    });

    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("false"));
  });

  it("puts the panel away for a link to a paragraph too", async () => {
    render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    act(() => {
      window.location.hash = "#p-abc123";
    });

    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("false"));
  });

  it("does not react to the address once it is gone from the page", async () => {
    const { unmount } = render(
      <MarginDrawer>
        <Panel />
      </MarginDrawer>,
    );
    unmount();

    // No listener left behind: this must not throw or warn about an unmounted update.
    act(() => {
      window.location.hash = "#proof";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("aside")).toBeNull();
  });
});
