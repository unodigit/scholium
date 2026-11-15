import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState } from "./empty-state";

afterEach(cleanup);

const SENTENCE =
  "No reviews yet — qualified in cs.AI? Review this paper.";

describe("EmptyState", () => {
  it("shows the one sentence and the one action", () => {
    render(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
      }),
    );

    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Review this paper" }).getAttribute("href"),
    ).toBe("/papers/123/review");

    // "One sentence and one action" is the contract: exactly one paragraph and
    // exactly one interactive element.
    const container = screen.getByText(SENTENCE).parentElement;
    expect(container).not.toBeNull();
    expect(container?.querySelectorAll("p")).toHaveLength(1);
    expect(
      container?.querySelectorAll("a, button, input, select, textarea"),
    ).toHaveLength(1);
  });

  it("renders the action as a button when it does something", () => {
    const onClick = vi.fn();
    render(
      createElement(EmptyState, {
        sentence: "Nothing here yet.",
        action: { label: "Reload", onClick },
      }),
    );

    const button = screen.getByRole("button", { name: "Reload" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables a button action when asked, and ignores disabled on a link", () => {
    render(
      createElement(EmptyState, {
        sentence: "Nothing here yet.",
        action: { label: "Reload", onClick: vi.fn(), disabled: true },
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Reload" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    cleanup();
    render(
      createElement(EmptyState, {
        sentence: "Nothing here yet.",
        action: { label: "Browse categories", href: "/categories", disabled: true },
      }),
    );
    expect(
      screen.getByRole("link", { name: "Browse categories" }).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
  });

  it("draws an optional icon as decoration, never as the message", () => {
    render(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
        icon: "eye",
      }),
    );

    const icon = screen.getByText(SENTENCE).parentElement?.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
  });

  it("renders no icon by default", () => {
    render(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
      }),
    );
    expect(screen.getByText(SENTENCE).parentElement?.querySelector("svg")).toBeNull();
  });

  it("renders nothing rather than an empty box or a dead end", () => {
    const cases: Array<Record<string, unknown>> = [
      { sentence: "", action: { label: "Go", href: "/" } },
      { sentence: "   ", action: { label: "Go", href: "/" } },
      { sentence: SENTENCE, action: { label: "", href: "/" } },
      { sentence: SENTENCE, action: { label: "   ", href: "/" } },
      { sentence: SENTENCE } as never,
    ];

    for (const props of cases) {
      const { container } = render(createElement(EmptyState, props as never));
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("sets no role of its own: it is content, not a live region", () => {
    const { container } = render(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
      }),
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("sch-empty")).toBe(true);
    expect(root.hasAttribute("role")).toBe(false);
    expect(root.hasAttribute("aria-live")).toBe(false);
  });

  it("passes className and other attributes through without losing its own", () => {
    const { container } = render(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
        className: "mt-4",
        id: "reviews-empty",
        "data-testid": "empty",
      } as never),
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe("sch-empty mt-4");
    expect(root.id).toBe("reviews-empty");
    expect(root.dataset.testid).toBe("empty");
  });

  it("renders on the server with the sentence and action in the HTML", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        sentence: SENTENCE,
        action: { label: "Review this paper", href: "/papers/123/review" },
      }),
    );
    expect(html).toContain("sch-empty");
    expect(html).toContain(SENTENCE);
    expect(html).toContain('href="/papers/123/review"');
  });
});
