// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LICENCE_ID, LICENCES, MAX_CATEGORIES, emptyDetails, type DetailsValues } from "./details";
import { DetailsStep, type DetailsStepProps } from "./details-step";

afterEach(cleanup);

/** The step with a real draft behind it, so typing and clicking behave as they do in the wizard. */
function Harness(props: Partial<DetailsStepProps>): React.ReactElement {
  const [value, setValue] = useState<DetailsValues>(emptyDetails);
  return <DetailsStep value={value} onChange={setValue} {...props} />;
}

const titleInput = (): HTMLInputElement => screen.getByLabelText("Title") as HTMLInputElement;
const abstractInput = (): HTMLTextAreaElement => screen.getByLabelText("Abstract") as HTMLTextAreaElement;
const chip = (id: string): HTMLButtonElement =>
  screen.getByRole("button", { name: new RegExp(`^${id.replace(".", "\\.")}`) }) as HTMLButtonElement;
const continueButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /Continue to/ }) as HTMLButtonElement;

function fill(title = "Sparse Probing of Reward Models", abstract = "We study whether sparse probes work."): void {
  fireEvent.change(titleInput(), { target: { value: title } });
  fireEvent.change(abstractInput(), { target: { value: abstract } });
}

describe("DetailsStep — what the step shows", () => {
  it("has a Details heading, a title, an abstract, categories and a licence", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { level: 2, name: "Details" })).toBeTruthy();
    expect(titleInput()).toBeTruthy();
    expect(abstractInput()).toBeTruthy();
    expect(screen.getByRole("group", { name: "Categories" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Licence" })).toBeTruthy();
  });

  it("puts focus on the title when the step opens, ready to type", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(titleInput());
  });

  it("states the character limits before they are reached", () => {
    render(<Harness />);
    expect(screen.getByText(/0 of 300 characters/)).toBeTruthy();
    expect(screen.getByText(/0 of 5000 characters/)).toBeTruthy();
    fireEvent.change(titleInput(), { target: { value: "Short" } });
    expect(screen.getByText(/5 of 300 characters/)).toBeTruthy();
  });

  it("shows each category id with its plain name for screen readers", () => {
    render(<Harness />);
    expect(chip("cs.AI").textContent).toContain("Artificial intelligence");
  });
});

describe("DetailsStep — licence picker", () => {
  it("defaults to CC BY 4.0", () => {
    render(<Harness />);
    const defaultLicence = screen.getByRole("radio", { name: /^CC BY 4\.0/ }) as HTMLInputElement;
    expect(defaultLicence.checked).toBe(true);
    expect(defaultLicence.value).toBe(DEFAULT_LICENCE_ID);
    expect(screen.getByRole("radio", { name: /^CC BY-SA 4\.0/ })).toBeTruthy();
  });

  it("offers every licence with a one-line explanation", () => {
    render(<Harness />);
    const licences = screen.getByRole("group", { name: "Licence" });
    for (const licence of LICENCES) {
      expect(within(licences).getByText(licence.summary)).toBeTruthy();
    }
  });

  it("flags journal-compatibility in words for every option", () => {
    render(<Harness />);
    const licences = screen.getByRole("group", { name: "Licence" });
    expect(within(licences).getAllByText("Accepted by most journals")).toHaveLength(2);
    expect(within(licences).getAllByText("Check your journal")).toHaveLength(3);
  });

  it("selects another licence when its card is clicked", () => {
    render(<Harness />);
    const sa = screen.getByRole("radio", { name: /^CC BY-SA 4\.0/ }) as HTMLInputElement;
    fireEvent.click(sa);
    expect(sa.checked).toBe(true);
    expect((screen.getByRole("radio", { name: /^CC BY 4\.0/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("makes the whole card a target, so clicking the explanation also chooses the licence", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText(LICENCES[2].summary));
    const nc = screen.getByRole("radio", { name: /^CC BY-NC 4\.0/ }) as HTMLInputElement;
    expect(nc.checked).toBe(true);
  });

  it("says the licence travels inside the signed record", () => {
    render(<Harness />);
    expect(screen.getByText(/Reuse rights are part of the signed record/)).toBeTruthy();
  });
});

describe("DetailsStep — categories", () => {
  it("starts with none chosen", () => {
    render(<Harness />);
    expect(screen.getByRole("status").textContent).toBe("No categories chosen yet.");
  });

  it("chooses up to three and marks each with a check as well as a colour", () => {
    render(<Harness />);
    fireEvent.click(chip("cs.AI"));
    fireEvent.click(chip("cs.LG"));

    expect(chip("cs.AI").getAttribute("aria-pressed")).toBe("true");
    expect(chip("cs.AI").querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(`2 of ${MAX_CATEGORIES} chosen: cs.AI, cs.LG.`);
  });

  it("disables the other categories at three, and enables them again when one is removed", () => {
    render(<Harness />);
    fireEvent.click(chip("cs.AI"));
    fireEvent.click(chip("cs.LG"));
    fireEvent.click(chip("cs.MA"));

    expect(chip("cs.CR").disabled).toBe(true);
    expect(chip("cs.AI").disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Remove one to choose another.");

    fireEvent.click(chip("cs.LG"));
    expect(chip("cs.CR").disabled).toBe(false);
    expect(chip("cs.LG").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("DetailsStep — leaving the step", () => {
  it("keeps Continue closed, saying what is missing, until the step is complete", () => {
    render(<Harness onContinue={vi.fn()} />);
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Add a title to continue.")).toBeTruthy();

    fireEvent.change(titleInput(), { target: { value: "A title" } });
    expect(screen.getByText("Add an abstract to continue.")).toBeTruthy();

    fireEvent.change(abstractInput(), { target: { value: "An abstract." } });
    expect(screen.getByText("Choose at least one category to continue.")).toBeTruthy();

    fireEvent.click(chip("cs.LG"));
    expect(continueButton().disabled).toBe(false);
  });

  it("sends the title, abstract, categories and licence when Continue is pressed", () => {
    const onContinue = vi.fn();
    render(<Harness onContinue={onContinue} />);
    fill();
    fireEvent.click(chip("cs.LG"));
    fireEvent.click(chip("cs.AI"));
    fireEvent.click(screen.getByRole("radio", { name: /^CC BY-NC 4\.0/ }));
    fireEvent.click(continueButton());

    expect(onContinue).toHaveBeenCalledWith({
      title: "Sparse Probing of Reward Models",
      abstract: "We study whether sparse probes work.",
      categories: ["cs.LG", "cs.AI"],
      licence: "CC-BY-NC-4.0",
    });
  });

  it("looks complete but stays closed when there is no step 3, and says why", () => {
    render(<Harness />);
    fill();
    fireEvent.click(chip("cs.LG"));

    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Step 3, Authors, is not open in this release yet.")).toBeTruthy();
  });

  it("offers Back to Files when the wizard gives it a way back", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Files" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("names the next step in the Continue button", () => {
    render(<Harness nextStepLabel="Authors" />);
    expect(screen.getByRole("button", { name: "Continue to Authors" })).toBeTruthy();
  });
});
