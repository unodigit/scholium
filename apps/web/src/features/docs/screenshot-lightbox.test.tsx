// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ScreenshotLightbox, type ScreenshotLightboxProps } from "./screenshot-lightbox";

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(cleanup);

const SHOT = {
  src: "/docs/screenshots/ch02-passkey-sign-in.webp",
  width: 1440,
  height: 900,
  alt: "Sign in with a passkey",
  caption: "Sign in with a passkey caption",
};

function renderShot(props: Partial<ScreenshotLightboxProps> = {}) {
  return render(<ScreenshotLightbox screenshot={{ ...SHOT, heading: "h", source: "s" }} {...props} />);
}

describe("screenshot lightbox", () => {
  it("renders the figure link with href, alt, etc", () => {
    renderShot();
    const link = screen.getByRole("link", { name: /full-size image/i });
    expect(link.getAttribute("href")).toBe(SHOT.src);
    const img = within(link).getByRole("img", { name: SHOT.alt });
    expect(img.getAttribute("src")).toBe(SHOT.src);
    expect(img.getAttribute("width")).toBe(String(SHOT.width));
    expect(img.getAttribute("height")).toBe(String(SHOT.height));
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("opens dialog on plain click and prevents navigation", () => {
    renderShot();
    const link = screen.getByRole("link", { name: /full-size image/i });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    // fireEvent easier:
    // already dispatched; check defaultPrevented
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    const dialogImg = within(dialog).getByRole("img", { name: SHOT.alt });
    expect(dialogImg.getAttribute("src")).toBe(SHOT.src);
    expect(dialogImg.getAttribute("alt")).toBe(SHOT.alt);
    expect(within(dialog).getByText(SHOT.caption)).toBeTruthy();
    // close button focus
    const closeBtn = screen.getByRole("button", { name: "Close image" });
    expect(document.activeElement).toBe(closeBtn);
  });

  it("restores root overflow on close", () => {
    renderShot();
    const link = screen.getByRole("link", { name: /full-size image/i });
    fireEvent.click(link);
    expect(document.documentElement.style.overflow).toBe("hidden");
    const closeBtn = screen.getByRole("button", { name: "Close image" });
    fireEvent.click(closeBtn);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.activeElement).toBe(link);
  });

  it("does not intercept Ctrl-click", () => {
    renderShot();
    const link = screen.getByRole("link", { name: /full-size image/i });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    const prevented = !link.dispatchEvent(event);
    // default not prevented by us; dispatchEvent returns true if not prevented
    expect(event.defaultPrevented).toBe(false);
  });

  it("escape closes and returns focus", () => {
    renderShot();
    const link = screen.getByRole("link", { name: /full-size image/i });
    fireEvent.click(link);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(document.activeElement).toBe(link);
  });
});
