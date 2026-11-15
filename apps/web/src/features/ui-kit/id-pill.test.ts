import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COPIED_MESSAGE,
  COPIED_RESET_MS,
  COPY_FAILED_MESSAGE,
  IdPill,
  type IdPillProps,
} from "./id-pill";
import { ICON_SHAPES } from "./icons";
import { TOAST_DURATION_MS, TOAST_REGION_ID, dismissToast } from "./toast";

const ID = "sch:k3f9-q2xz-7mwd/v3";

function stubClipboardApi(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function region(): HTMLElement | null {
  return document.getElementById(TOAST_REGION_ID);
}

function pill(): HTMLElement {
  return screen.getByRole("button", { name: `Copy ${ID}` });
}

/** Click, then let the clipboard promise and its follow-up settle. */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function iconShapes(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll("svg path")).map(
    (path) => path.getAttribute("d") ?? "",
  );
}

const COPY_SHAPES = ICON_SHAPES.copy.map((shape) => shape.attrs.d as string);
const CHECK_SHAPES = ICON_SHAPES.check.map((shape) => shape.attrs.d as string);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  dismissToast();
  region()?.remove();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  vi.useRealTimers();
});

describe("IdPill markup", () => {
  it("is a real button that shows the id", () => {
    render(createElement(IdPill, { schId: ID }));

    const button = pill();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent).toBe(ID);
    expect(button.classList.contains("sch-id-pill")).toBe(true);
  });

  it("sets the id in its own monospace element", () => {
    render(createElement(IdPill, { schId: ID }));

    const text = pill().querySelector(".sch-id-pill__id");
    expect(text?.textContent).toBe(ID);
  });

  it("names itself 'Copy <id>', which contains the visible text", () => {
    render(createElement(IdPill, { schId: ID }));

    const name = pill().getAttribute("aria-label") ?? "";
    expect(name).toBe(`Copy ${ID}`);
    expect(name).toContain(pill().textContent ?? "");
  });

  it("draws a decorative copy glyph that assistive technology skips", () => {
    render(createElement(IdPill, { schId: ID }));

    const icon = pill().querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.classList.contains("sch-id-pill__icon")).toBe(true);
    expect(iconShapes(pill())).toEqual(COPY_SHAPES);
  });

  it("trims the id it shows", () => {
    render(createElement(IdPill, { schId: `  ${ID}\n` }));
    expect(pill().textContent).toBe(ID);
  });

  it("shows the id exactly as given: it does not add a prefix or a version", () => {
    render(createElement(IdPill, { schId: "k3f9-q2xz-7mwd" }));
    expect(screen.getByRole("button").textContent).toBe("k3f9-q2xz-7mwd");
  });

  it.each(["", "   ", "\t\n"])("renders nothing for a blank id (%j)", (schId) => {
    const { container } = render(createElement(IdPill, { schId }));
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the id is not a string", () => {
    const { container } = render(
      createElement(IdPill, { schId: undefined as unknown as string }),
    );
    expect(container.firstChild).toBeNull();
  });

  it("merges a caller's className and passes other attributes through", () => {
    // `data-*` attributes are not in the props type; JSX allows them, a
    // `createElement` object literal needs the assertion.
    const props = {
      schId: ID,
      className: "ml-2",
      "data-testid": "paper-id",
      title: "Paper id",
    } as IdPillProps;
    render(createElement(IdPill, props));

    const button = screen.getByTestId("paper-id");
    expect(button.classList.contains("sch-id-pill")).toBe(true);
    expect(button.classList.contains("ml-2")).toBe(true);
    expect(button.getAttribute("title")).toBe("Paper id");
  });

  it("leaves the DOM onCopy clipboard-event handler alone", () => {
    const onCopy = vi.fn();
    render(createElement(IdPill, { schId: ID, onCopy }));

    fireEvent.copy(pill());
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("lets a caller replace the accessible name", () => {
    render(createElement(IdPill, { schId: ID, "aria-label": `Copy paper id ${ID}` }));
    expect(
      screen.getByRole("button", { name: `Copy paper id ${ID}` }),
    ).toBeTruthy();
  });

  it("cannot be turned into a submit button", () => {
    render(
      createElement(
        "form",
        null,
        createElement(IdPill, { schId: ID, type: "submit" } as never),
      ),
    );
    expect(pill().getAttribute("type")).toBe("button");
  });

  it("puts the toast's live region in the page when it mounts, before any click", () => {
    expect(region()).toBeNull();
    render(createElement(IdPill, { schId: ID }));

    const live = region();
    expect(live).not.toBeNull();
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.textContent).toBe("");
  });

  it("does not copy, or toast, until it is clicked", () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);
    render(createElement(IdPill, { schId: ID }));

    expect(writeText).not.toHaveBeenCalled();
    expect(region()?.textContent).toBe("");
  });
});

describe("IdPill copying", () => {
  it("copies the id on click", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(ID);
  });

  it("copies the trimmed id, the same text it shows", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);
    render(createElement(IdPill, { schId: `  ${ID}  ` }));

    await click(pill());
    expect(writeText).toHaveBeenCalledWith(ID);
  });

  it("starts the copy synchronously inside the click, within the user gesture", () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);
    render(createElement(IdPill, { schId: ID }));

    fireEvent.click(pill());
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("shows the 'Copied' toast in the live region", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());

    expect(COPIED_MESSAGE).toBe("Copied");
    expect(region()?.textContent).toBe("Copied");
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("does not show the toast before the clipboard has accepted the text", async () => {
    let resolveWrite: () => void = () => undefined;
    stubClipboardApi(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    render(createElement(IdPill, { schId: ID }));

    await act(async () => {
      fireEvent.click(pill());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(region()?.textContent).toBe("");

    await act(async () => {
      resolveWrite();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(region()?.textContent).toBe("Copied");
  });

  it("swaps the copy glyph for a tick, and back after two seconds", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));
    expect(pill().getAttribute("data-copied")).toBe("false");

    await click(pill());
    expect(pill().getAttribute("data-copied")).toBe("true");
    expect(iconShapes(pill())).toEqual(CHECK_SHAPES);

    await tick(COPIED_RESET_MS - 1);
    expect(pill().getAttribute("data-copied")).toBe("true");

    await tick(1);
    expect(pill().getAttribute("data-copied")).toBe("false");
    expect(iconShapes(pill())).toEqual(COPY_SHAPES);
  });

  it("keeps its accessible name and visible id while showing the tick", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    expect(pill().getAttribute("aria-label")).toBe(`Copy ${ID}`);
    expect(pill().textContent).toBe(ID);
  });

  it("removes the toast after its own duration", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    await tick(TOAST_DURATION_MS);
    expect(region()?.textContent).toBe("");
  });

  it("restarts the tick's two seconds on a second click", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    await tick(COPIED_RESET_MS - 500);
    await click(pill());

    await tick(COPIED_RESET_MS - 1);
    expect(pill().getAttribute("data-copied")).toBe("true");
    await tick(1);
    expect(pill().getAttribute("data-copied")).toBe("false");
  });

  it("shows one toast after repeated clicks, not a stack", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    await click(pill());
    await click(pill());

    expect(document.querySelectorAll(".sch-toast")).toHaveLength(1);
  });

  it("calls onCopied with the copied id", async () => {
    stubClipboardApi(async () => undefined);
    const onCopied = vi.fn();
    render(createElement(IdPill, { schId: ID, onCopied }));

    await click(pill());
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(onCopied).toHaveBeenCalledWith(ID);
  });

  it("calls the latest onCopied, even if the prop changed after mount", async () => {
    stubClipboardApi(async () => undefined);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(createElement(IdPill, { schId: ID, onCopied: first }));
    rerender(createElement(IdPill, { schId: ID, onCopied: second }));

    await click(pill());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("falls back to execCommand when there is no Clipboard API", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(region()?.textContent).toBe("Copied");
  });
});

describe("IdPill when the copy fails", () => {
  it("says 'Couldn't copy', never 'Copied'", async () => {
    stubClipboardApi(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    render(createElement(IdPill, { schId: ID }));

    await click(pill());

    expect(COPY_FAILED_MESSAGE).toBe("Couldn't copy");
    expect(region()?.textContent).toBe("Couldn't copy");
    expect(region()?.textContent).not.toContain("Copied");
  });

  it("leaves the glyph as the copy glyph and does not call onCopied", async () => {
    stubClipboardApi(async () => {
      throw new Error("denied");
    });
    const onCopied = vi.fn();
    render(createElement(IdPill, { schId: ID, onCopied }));

    await click(pill());

    expect(pill().getAttribute("data-copied")).toBe("false");
    expect(iconShapes(pill())).toEqual(COPY_SHAPES);
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("says 'Couldn't copy' when the browser has no way to copy at all", async () => {
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    expect(region()?.textContent).toBe("Couldn't copy");
  });

  it("can be tried again, and a later success replaces the failure toast", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(undefined);
    stubClipboardApi(writeText);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    expect(region()?.textContent).toBe("Couldn't copy");

    await click(pill());
    expect(region()?.textContent).toBe("Copied");
    expect(document.querySelectorAll(".sch-toast")).toHaveLength(1);
  });
});

describe("IdPill theming and lifecycle", () => {
  it("shows the toast in the theme of the subtree the pill sits in", async () => {
    stubClipboardApi(async () => undefined);
    render(
      createElement(
        "div",
        { "data-theme": "dark" },
        createElement(IdPill, { schId: ID }),
      ),
    );

    await click(pill());
    expect(document.querySelector(".sch-toast")?.getAttribute("data-theme")).toBe(
      "dark",
    );
  });

  it("leaves the toast on the page theme when no subtree sets one", async () => {
    stubClipboardApi(async () => undefined);
    render(createElement(IdPill, { schId: ID }));

    await click(pill());
    expect(
      document.querySelector(".sch-toast")?.hasAttribute("data-theme"),
    ).toBe(false);
  });

  it("still shows the toast if the pill is removed while the copy is pending", async () => {
    let resolveWrite: () => void = () => undefined;
    stubClipboardApi(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const onCopied = vi.fn();
    const { unmount } = render(createElement(IdPill, { schId: ID, onCopied }));

    fireEvent.click(pill());
    unmount();

    await act(async () => {
      resolveWrite();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(region()?.textContent).toBe("Copied");
    expect(onCopied).toHaveBeenCalledWith(ID);
  });

  it("clears its reset timer on unmount", async () => {
    stubClipboardApi(async () => undefined);
    const { unmount } = render(createElement(IdPill, { schId: ID }));

    await click(pill());
    unmount();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the toast's own timer

    await expect(tick(COPIED_RESET_MS)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can show several pills; one click copies only that pill's id", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);
    const other = "sch:9f2c-1a7e-0b4d";
    render(
      createElement(
        "div",
        null,
        createElement(IdPill, { schId: ID }),
        createElement(IdPill, { schId: other }),
      ),
    );

    await click(screen.getByRole("button", { name: `Copy ${other}` }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(other);
    expect(
      screen.getByRole("button", { name: `Copy ${ID}` }).getAttribute("data-copied"),
    ).toBe("false");
    expect(document.querySelectorAll(`#${TOAST_REGION_ID}`)).toHaveLength(1);
  });
});
