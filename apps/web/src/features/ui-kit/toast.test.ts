import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOAST_DURATION_MS,
  TOAST_REGION_ID,
  dismissToast,
  ensureToastRegion,
  showToast,
} from "./toast";

function region(): HTMLElement | null {
  return document.getElementById(TOAST_REGION_ID);
}

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".sch-toast"));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  dismissToast();
  region()?.remove();
  vi.useRealTimers();
});

describe("ensureToastRegion", () => {
  it("creates one polite status region on the body", () => {
    const created = ensureToastRegion();

    expect(created).not.toBeNull();
    expect(created?.parentElement).toBe(document.body);
    expect(created?.getAttribute("role")).toBe("status");
    expect(created?.getAttribute("aria-live")).toBe("polite");
    expect(created?.classList.contains("sch-toast-region")).toBe(true);
  });

  it("is idempotent: asking again returns the same node, never a second region", () => {
    const first = ensureToastRegion();
    const second = ensureToastRegion();

    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${TOAST_REGION_ID}`)).toHaveLength(1);
  });

  it("starts empty, so nothing is announced until there is a message", () => {
    expect(ensureToastRegion()?.childElementCount).toBe(0);
  });
});

describe("showToast", () => {
  it("writes the message into the live region", () => {
    showToast("Copied");

    expect(region()?.textContent).toBe("Copied");
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].parentElement).toBe(region());
  });

  it("creates the region itself when no component asked for it first", () => {
    expect(region()).toBeNull();
    showToast("Copied");
    expect(region()).not.toBeNull();
  });

  it("renders the message as text, never as markup", () => {
    showToast("<img src=x onerror=alert(1)>");

    expect(region()?.querySelector("img")).toBeNull();
    expect(region()?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("replaces the toast on screen instead of stacking a second", () => {
    showToast("Copied");
    showToast("Couldn't copy");

    expect(toasts()).toHaveLength(1);
    expect(region()?.textContent).toBe("Couldn't copy");
  });

  it("writes a fresh element for repeated text, so it is announced again", () => {
    showToast("Copied");
    const first = toasts()[0];
    showToast("Copied");

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).not.toBe(first);
  });

  it("goes away after the default duration and leaves the region in place", () => {
    showToast("Copied");

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(toasts()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
    expect(region()).not.toBeNull();
  });

  it("honours a custom duration", () => {
    showToast("Copied", { duration: 500 });

    vi.advanceTimersByTime(499);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default duration for %s, rather than vanishing at once",
    (duration) => {
      showToast("Copied", { duration });

      vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
      expect(toasts()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(toasts()).toHaveLength(0);
    },
  );

  it("restarts the clock for a newer toast; the older timer cannot cut it short", () => {
    showToast("Copied");
    vi.advanceTimersByTime(TOAST_DURATION_MS - 100);
    showToast("Copied again");

    vi.advanceTimersByTime(200);
    expect(region()?.textContent).toBe("Copied again");

    vi.advanceTimersByTime(TOAST_DURATION_MS - 200);
    expect(toasts()).toHaveLength(0);
  });

  it("renders in the caller's theme when it is given one", () => {
    showToast("Copied", { theme: "dark" });
    expect(toasts()[0].getAttribute("data-theme")).toBe("dark");
  });

  it("sets no theme attribute when there is none, so the page theme applies", () => {
    showToast("Copied", { theme: null });
    expect(toasts()[0].hasAttribute("data-theme")).toBe(false);
  });

  it.each(["", "   ", "\n"])("ignores a blank message (%j)", (message) => {
    showToast(message);
    expect(toasts()).toHaveLength(0);
  });

  it("keeps the toast already showing when a blank one is requested", () => {
    showToast("Copied");
    showToast("");
    expect(region()?.textContent).toBe("Copied");
  });
});

describe("dismissToast", () => {
  it("removes the toast now and keeps the region", () => {
    showToast("Copied");
    dismissToast();

    expect(toasts()).toHaveLength(0);
    expect(region()).not.toBeNull();
  });

  it("is safe when nothing is showing and no region exists", () => {
    expect(() => dismissToast()).not.toThrow();
  });

  it("cancels the pending timer so it cannot remove a later toast", () => {
    showToast("Copied");
    vi.advanceTimersByTime(TOAST_DURATION_MS - 100);
    dismissToast();
    showToast("Next");

    vi.advanceTimersByTime(200);
    expect(region()?.textContent).toBe("Next");
  });
});
