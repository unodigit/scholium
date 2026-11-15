// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_ITEM_HINT,
  ARCHIVE_ITEM_LABEL,
  DOWNLOAD_LABEL,
  DownloadMenu,
} from "./download-menu";

/**
 * The Download menu: a link to the archive until the page runs, then a menu
 * button following the WAI-ARIA menu-button pattern. The archive's address is
 * the node's `GET /v1/export/paper/{id}.car`; the menu only has to offer it,
 * with `download`, and be operable from the keyboard.
 */

const ARCHIVE = "http://node.test/v1/export/paper/sch%3A6sel-2dio-orm6.car";

const button = () => screen.getByRole("button", { name: DOWNLOAD_LABEL });
/** Hidden menus are not in the accessibility tree, so ask for them by id. */
const list = () => document.getElementById(button().getAttribute("aria-controls") as string) as HTMLElement;
const item = () => screen.getByRole("menuitem", { name: new RegExp(ARCHIVE_ITEM_LABEL) });

function show() {
  return render(<DownloadMenu href={ARCHIVE} />);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("before the page runs", () => {
  it("is a link that saves the archive", () => {
    document.body.innerHTML = renderToStaticMarkup(<DownloadMenu href={ARCHIVE} />);

    const link = screen.getByRole("link", { name: DOWNLOAD_LABEL });
    expect(link.getAttribute("href")).toBe(ARCHIVE);
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("title")).toBe(ARCHIVE_ITEM_HINT);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("once the page runs", () => {
  it("is a button that says it opens a menu, and that the menu is closed", () => {
    show();

    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: DOWNLOAD_LABEL })).toBeNull();
  });

  it("keeps the menu out of the page's reading order and tab order while it is closed", () => {
    show();

    expect(list().hidden).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("points the button at its menu", () => {
    show();

    expect(list().getAttribute("role")).toBe("menu");
    expect(list().getAttribute("aria-label")).toBe(DOWNLOAD_LABEL);
  });
});

describe("opening", () => {
  it("opens on a click, and says so", () => {
    show();

    fireEvent.click(button());

    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: DOWNLOAD_LABEL })).toBeTruthy();
  });

  it("offers the paper's archive, as a download from the node", () => {
    show();
    fireEvent.click(button());

    expect(item().getAttribute("href")).toBe(ARCHIVE);
    expect(item().hasAttribute("download")).toBe(true);
    expect(item().textContent).toContain(ARCHIVE_ITEM_HINT);
  });

  it("moves focus to the first item", () => {
    show();

    fireEvent.click(button());

    expect(document.activeElement).toBe(item());
  });

  it("closes on a second click on the button", () => {
    show();
    fireEvent.click(button());

    fireEvent.click(button());

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(list().hidden).toBe(true);
  });

  it("opens on ArrowDown from the button, on the first item", () => {
    show();
    button().focus();

    const prevented = !fireEvent.keyDown(button(), { key: "ArrowDown" });

    expect(prevented).toBe(true);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(item());
  });

  it("opens on ArrowUp from the button, on the last item", () => {
    show();
    button().focus();

    fireEvent.keyDown(button(), { key: "ArrowUp" });

    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(item());
  });

  it("moves focus to the item when an arrow key is pressed on a menu that is already open", () => {
    show();
    fireEvent.click(button());
    button().focus();

    fireEvent.keyDown(button(), { key: "ArrowDown" });

    expect(document.activeElement).toBe(item());
  });
});

describe("keyboard inside the menu", () => {
  it.each(["ArrowDown", "ArrowUp", "Home", "End"])("keeps focus on the only item for %s", (key) => {
    show();
    fireEvent.click(button());

    const prevented = !fireEvent.keyDown(item(), { key });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(item());
  });

  describe("with more than one item", () => {
    /** The menu has one item today; give it three to check the arrows go round. */
    function withThreeItems(): HTMLElement[] {
      show();
      fireEvent.click(button());
      for (const name of ["Second", "Third"]) {
        const extra = document.createElement("a");
        extra.setAttribute("role", "menuitem");
        extra.setAttribute("tabindex", "-1");
        extra.setAttribute("href", `#${name}`);
        extra.textContent = name;
        list().appendChild(extra);
      }
      return Array.from(list().querySelectorAll<HTMLElement>('[role="menuitem"]'));
    }

    it("moves down and wraps from the last to the first", () => {
      const [first, second, third] = withThreeItems();
      first.focus();

      fireEvent.keyDown(first, { key: "ArrowDown" });
      expect(document.activeElement).toBe(second);
      fireEvent.keyDown(second, { key: "ArrowDown" });
      expect(document.activeElement).toBe(third);
      fireEvent.keyDown(third, { key: "ArrowDown" });
      expect(document.activeElement).toBe(first);
    });

    it("moves up and wraps from the first to the last", () => {
      const [first, second, third] = withThreeItems();
      first.focus();

      fireEvent.keyDown(first, { key: "ArrowUp" });
      expect(document.activeElement).toBe(third);
      fireEvent.keyDown(third, { key: "ArrowUp" });
      expect(document.activeElement).toBe(second);
    });

    it("jumps to the first with Home and the last with End", () => {
      const [first, , third] = withThreeItems();
      first.focus();

      fireEvent.keyDown(first, { key: "End" });
      expect(document.activeElement).toBe(third);
      fireEvent.keyDown(third, { key: "Home" });
      expect(document.activeElement).toBe(first);
    });

    it("goes to the last item for ArrowUp pressed on the menu itself", () => {
      const [, , third] = withThreeItems();
      list().focus();

      fireEvent.keyDown(list(), { key: "ArrowUp" });

      expect(document.activeElement).toBe(third);
    });

    it("opens on ArrowUp from the button, on the last item", () => {
      show();
      for (const name of ["Second", "Third"]) {
        const extra = document.createElement("a");
        extra.setAttribute("role", "menuitem");
        extra.setAttribute("tabindex", "-1");
        extra.textContent = name;
        list().appendChild(extra);
      }
      button().focus();

      fireEvent.keyDown(button(), { key: "ArrowUp" });

      expect(document.activeElement?.textContent).toBe("Third");
    });
  });

  it("closes on Escape and puts focus back on the button", () => {
    show();
    fireEvent.click(button());

    fireEvent.keyDown(item(), { key: "Escape" });

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
  });

  it("closes on Escape wherever focus is", () => {
    show();
    fireEvent.click(button());
    (document.activeElement as HTMLElement).blur();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
  });

  it("closes on Tab and lets the browser carry on from the button", () => {
    show();
    fireEvent.click(button());

    const prevented = !fireEvent.keyDown(item(), { key: "Tab" });

    expect(prevented).toBe(false);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
  });
});

describe("choosing and leaving", () => {
  it("closes when the archive is chosen, and leaves the item in the page so the download can start", () => {
    show();
    fireEvent.click(button());
    const chosen = item();

    fireEvent.click(chosen);

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.contains(chosen)).toBe(true);
    expect(chosen.getAttribute("href")).toBe(ARCHIVE);
    expect(document.activeElement).toBe(button());
  });

  it("closes when the page is pressed elsewhere, and leaves focus where the reader put it", () => {
    render(
      <>
        <DownloadMenu href={ARCHIVE} />
        <input aria-label="Elsewhere" />
      </>,
    );
    fireEvent.click(button());
    const elsewhere = screen.getByLabelText("Elsewhere");
    elsewhere.focus();

    fireEvent.pointerDown(elsewhere);

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("stays open when the press is inside the menu", () => {
    show();
    fireEvent.click(button());

    fireEvent.pointerDown(list());
    fireEvent.pointerDown(item());

    expect(button().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not listen for presses or keys while it is closed", () => {
    show();

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });

  it("opens again after it was closed", () => {
    show();
    fireEvent.click(button());
    fireEvent.keyDown(item(), { key: "Escape" });

    fireEvent.click(button());

    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(item());
  });
});
