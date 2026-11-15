// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubmitWizard } from "./submit-wizard";
import { WizardRail } from "./wizard-rail";
import { WIZARD_STEPS, nextStep, stepIndex } from "./wizard-steps";
import type { ManagerDeps } from "./upload-manager";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

afterEach(cleanup);

describe("wizard steps", () => {
  it("are Files, Details, Authors, Checks, Sign, in that order", () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual(["Files", "Details", "Authors", "Checks", "Sign"]);
  });

  it("know their position and what follows", () => {
    expect(stepIndex("authors")).toBe(2);
    expect(nextStep("files")).toMatchObject({ id: "details", label: "Details" });
    expect(nextStep("sign")).toBeNull();
  });
});

describe("WizardRail", () => {
  it("lists all five steps and marks the current one", () => {
    render(<WizardRail current="files" />);
    const rail = screen.getByRole("navigation", { name: "Submission progress" });
    const items = within(rail).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0].getAttribute("aria-current")).toBe("step");
    expect(items.slice(1).every((item) => item.getAttribute("aria-current") === null)).toBe(true);
  });

  it("says in words which steps are done, current and ahead, so colour is never the only signal", () => {
    render(<WizardRail current="authors" />);
    const items = within(screen.getByRole("navigation")).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "current",
      "ahead",
      "ahead",
    ]);
    expect(items[0].textContent).toContain("(done)");
    expect(items[3].textContent).toContain("(not started)");
    expect(items[2].textContent).not.toMatch(/\(done\)|\(not started\)/);
  });
});

describe("SubmitWizard", () => {
  it("shows the heading, the rail at step 1 and the Files step", () => {
    render(<SubmitWizard signedIn />);
    expect(screen.getByRole("heading", { level: 1, name: "Submit a paper" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Submission progress" }))
        .getAllByRole("listitem")[0]
        .getAttribute("aria-current"),
    ).toBe("step");
    expect(screen.getByRole("complementary", { name: "Size limits" })).toBeTruthy();
  });

  it("offers sign-in, returning to /submit, to someone who is signed out", () => {
    render(<SubmitWizard signedIn={false} />);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/signin?next=%2Fsubmit");
  });

  it("does not nag someone who is signed in", () => {
    render(<SubmitWizard signedIn />);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });
});

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/** A fingerprinter and uploader the test drives by hand, so no network is needed. */
function fakeManagerDeps(): {
  deps: ManagerDeps;
  uploads: { callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2] }[];
  hashes: { resolve: (cid: string) => void }[];
} {
  const uploads: { callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2] }[] = [];
  const hashes: { resolve: (cid: string) => void }[] = [];
  const deps: ManagerDeps = {
    startUpload: (_file, _init, callbacks) => {
      uploads.push({ callbacks });
      return { stop: vi.fn(async () => undefined) };
    },
    fingerprint: () =>
      new Promise<string>((resolve) => {
        hashes.push({ resolve });
      }),
  };
  return { deps, uploads, hashes };
}

describe("SubmitWizard — Files to Details and back", () => {
  it("opens step 2 after Files, and Back finds the same files", async () => {
    const { deps, uploads, hashes } = fakeManagerDeps();
    render(<SubmitWizard signedIn managerDeps={deps} />);

    fireEvent.change(screen.getByLabelText("Choose paper files"), {
      target: { files: [new File(["x"], "paper.pdf", { type: "application/pdf" })] },
    });
    await act(async () => {
      uploads[0].callbacks.onSuccess({ cid: CID, url: null });
      hashes[0].resolve(CID);
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Details" }));

    expect(screen.getByRole("heading", { level: 2, name: "Details" })).toBeTruthy();
    const steps = (): HTMLElement[] =>
      within(screen.getByRole("navigation", { name: "Submission progress" })).getAllByRole("listitem");
    expect(steps()[0].getAttribute("data-state")).toBe("done");
    expect(steps()[1].getAttribute("aria-current")).toBe("step");
    // The Files step is out of the way while Details is open.
    expect(screen.queryByRole("heading", { level: 2, name: "Files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));

    expect(screen.getByRole("heading", { level: 2, name: "Files" })).toBeTruthy();
    expect(screen.getByText("paper.pdf", { selector: ".sw-file__name" })).toBeTruthy();
    expect(steps()[0].getAttribute("aria-current")).toBe("step");
  });
});
