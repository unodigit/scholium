// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let pathnameValue = "/me";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => ({ replace }),
}));

// The provider's own bootstrap is the subject; `session.test.ts` covers the
// refresh sharing.  Keeping it mockable lets each case decide the answer.
vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return { ...actual, bootstrapSession: vi.fn() };
});

import { bootstrapSession } from "./session";
import { SessionProvider } from "./session-provider";
import { tokenStore } from "./tokens";

const bootstrapMock = vi.mocked(bootstrapSession);

/** The provider with a page inside it (no JSX: this directory has no `jsx` tsconfig). */
function page(text = "private dashboard") {
  return createElement(SessionProvider, null, createElement("p", null, text));
}

beforeEach(() => {
  replace.mockReset();
  pathnameValue = "/me";
  window.history.replaceState(null, "", "/me");
  tokenStore.clear();
  bootstrapMock.mockReset();
  bootstrapMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
});

describe("SessionProvider", () => {
  it("waits for the refresh before rendering a protected page", () => {
    render(page());

    expect(screen.getByRole("status").textContent).toContain(
      "Restoring your session",
    );
    expect(screen.queryByText("private dashboard")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders the protected page once the cookie restored a session", async () => {
    tokenStore.set({ accessToken: "restored" });
    bootstrapMock.mockResolvedValue({ accessToken: "restored" });

    render(page());

    await waitFor(() =>
      expect(screen.getByText("private dashboard")).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("sends a signed-out visitor of a protected page to sign in", async () => {
    window.history.replaceState(null, "", "/me?tab=papers#top");
    pathnameValue = "/me";

    render(page());

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/signin?next=${encodeURIComponent("/me?tab=papers#top")}`,
      ),
    );
    expect(screen.queryByText("private dashboard")).toBeNull();
  });

  it("does not hold up a public page", async () => {
    pathnameValue = "/";
    window.history.replaceState(null, "", "/");

    render(page("public feed"));

    expect(screen.getByText("public feed")).toBeTruthy();
    await waitFor(() => expect(bootstrapMock).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to sign-in when the session dies while a protected page is open", async () => {
    pathnameValue = "/me";
    tokenStore.set({ accessToken: "restored" });
    bootstrapMock.mockResolvedValue({ accessToken: "restored" });

    render(page());
    await waitFor(() =>
      expect(screen.getByText("private dashboard")).toBeTruthy(),
    );

    window.dispatchEvent(new Event("scholium:unauthorized"));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/signin?next=${encodeURIComponent("/me")}`,
      ),
    );
  });

  it("re-checks the session when the browser restores the page after the ORCID detour", async () => {
    // The document was loaded from the back-forward cache after the whole-page
    // trip to ORCID. The first bootstrap ran before the refresh cookie was
    // seen (or its answer was stale); returning to the page must ask again
    // instead of leaving the newcomer signed out.
    pathnameValue = "/me";
    bootstrapMock.mockResolvedValueOnce(null);
    bootstrapMock.mockImplementationOnce(async () => {
      tokenStore.set({ accessToken: "restored" });
      return { accessToken: "restored" };
    });

    render(page());
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/signin?next=${encodeURIComponent("/me")}`,
      ),
    );
    replace.mockReset();

    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(restored);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Asking again is what finds the still-valid refresh cookie; the page is
    // not sent to sign-in a second time.
    await waitFor(() => expect(bootstrapMock).toHaveBeenCalledTimes(2));
    expect(tokenStore.isAuthenticated).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });
});
