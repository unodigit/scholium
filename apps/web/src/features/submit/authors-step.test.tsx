// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialAuthors, type AuthorLookup, type DraftAuthor, type ResolveAuthor } from "./authors";
import { AuthorsStep, type AuthorsStepProps } from "./authors-step";
import type { ConsentReport } from "./consents";

afterEach(cleanup);

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ADA = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const GRACE = "did:key:z6MkwFkMwEJeKXqpUFpqcdUjh7KzDnQPFAgZSjMP9KqYvHeJ";
const ORCID = "0000-0002-1825-0097";

/** The step with a real roster behind it, so typing and clicking behave as they do in the wizard. */
function Harness({
  initial,
  ...props
}: Partial<AuthorsStepProps> & { initial?: DraftAuthor[] }): React.ReactElement {
  const [authors, setAuthors] = useState<DraftAuthor[]>(initial ?? initialAuthors(ME));
  return <AuthorsStep authors={authors} onChange={setAuthors} {...props} />;
}

const identifierInput = (): HTMLInputElement => screen.getByLabelText("DID, ORCID iD or email") as HTMLInputElement;
const nameInput = (): HTMLInputElement => screen.getByLabelText("Name (optional)") as HTMLInputElement;
const addButton = (): HTMLButtonElement => screen.getByRole("button", { name: "Add co-author" }) as HTMLButtonElement;
const continueButton = (): HTMLButtonElement => screen.getByRole("button", { name: /Continue to/ }) as HTMLButtonElement;
const byline = (): HTMLElement => screen.getByRole("list", { name: "Authors, in byline order" });
const rows = (): HTMLElement[] => within(byline()).getAllByRole("listitem").filter((li) => li.matches(".sw-author"));
const rowFor = (label: string): HTMLElement => {
  const row = rows().find((li) => li.querySelector(".sw-author__name")?.textContent?.startsWith(label));
  if (!row) throw new Error(`no row for ${label}`);
  return row;
};
const announcement = (): string | null => screen.getByRole("status", { name: "Author list updates" }).textContent;
const names = (): string[] => rows().map((li) => li.querySelector(".sw-author__name")?.textContent ?? "");

function addCoauthor(identifier: string, name = ""): void {
  fireEvent.change(identifierInput(), { target: { value: identifier } });
  if (name !== "") fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.click(addButton());
}

const role = (row: HTMLElement, id: string): HTMLButtonElement =>
  within(row).getByRole("button", { name: new RegExp(`^${id}`) }) as HTMLButtonElement;

function consentReport(statuses: [string, string][], extra: Partial<ConsentReport> = {}): ConsentReport {
  const authors = statuses.map(([did, status], index) => ({
    did,
    position: index + 1,
    status,
  }));
  const count = (status: string): number => authors.filter((a) => a.status === status).length;
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiexample",
    state: "awaiting_consent",
    count: authors.length,
    waiting: count("waiting"),
    signed: count("signed"),
    declined: count("declined"),
    authors,
    ...extra,
  };
}

describe("AuthorsStep — what the step shows", () => {
  it("has an Authors heading, an add form, the submitter first and the consent tracker", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { level: 2, name: "Authors" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Add a co-author" })).toBeTruthy();
    expect(names()).toEqual(["You"]);
    expect(rowFor("You").textContent).not.toContain("Remove");
    expect(screen.getByRole("region", { name: "Co-author consents" })).toBeTruthy();
  });

  it("puts focus in the identifier box when the step opens, ready to type", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(identifierInput());
  });

  it("says each co-author gets a consent link, and when", () => {
    render(<Harness />);
    expect(screen.getByText(/gets a consent link and must sign/)).toBeTruthy();
    expect(screen.getByText(/Each co-author gets a consent link when you sign and submit/)).toBeTruthy();
  });
});

describe("AuthorsStep — adding a co-author", () => {
  it("adds by DID, shows them with their name, and clears the form", () => {
    render(<Harness />);
    addCoauthor(ADA, "Ada Lovelace");
    expect(names()).toEqual(["You", "Ada Lovelace"]);
    expect(rowFor("Ada Lovelace").textContent).toContain("DID");
    expect(identifierInput().value).toBe("");
    expect(nameInput().value).toBe("");
    expect(document.activeElement).toBe(identifierInput());
    expect(announcement()).toContain("Added Ada Lovelace");
  });

  it("draws an avatar's letters from the name without its title", () => {
    render(<Harness />);
    addCoauthor(ADA, "Dr. Tunde Okafor");
    expect(rowFor("Dr. Tunde Okafor").querySelector(".sw-avatar")?.textContent).toBe("TO");
  });

  it("adds by ORCID iD, whatever spelling it was pasted in", () => {
    render(<Harness />);
    addCoauthor(`https://orcid.org/${ORCID}`, "Josiah Carberry");
    const row = rowFor("Josiah Carberry");
    expect(row.textContent).toContain(`ORCID iD · ${ORCID}`);
    expect(within(row).getByText("Not matched")).toBeTruthy();
  });

  it("adds by email, lower-cased", () => {
    render(<Harness />);
    addCoauthor("  Grace@Example.ORG ");
    expect(names()).toEqual(["You", "grace@example.org"]);
  });

  it("submits with Enter in the identifier box", () => {
    render(<Harness />);
    fireEvent.change(identifierInput(), { target: { value: "grace@example.org" } });
    fireEvent.submit(identifierInput().closest("form")!);
    expect(names()).toEqual(["You", "grace@example.org"]);
  });

  it("says what kind of identifier it sees while typing", () => {
    render(<Harness />);
    const hint = (): string => document.getElementById("sw-authors-identifier-hint")!.textContent ?? "";
    expect(hint()).toContain("did:key:");
    fireEvent.change(identifierInput(), { target: { value: ORCID } });
    expect(hint()).toBe("Looks like an ORCID iD.");
    fireEvent.change(identifierInput(), { target: { value: "ada@example.org" } });
    expect(hint()).toBe("Looks like an email address.");
    fireEvent.change(identifierInput(), { target: { value: ADA } });
    expect(hint()).toBe("Looks like a DID.");
  });

  it("explains a bad identifier in an alert, keeps what was typed and keeps focus there", () => {
    render(<Harness />);
    addCoauthor("0000-0002-1825-0098");
    expect(screen.getByRole("alert").textContent).toContain("fails its check digit");
    expect(identifierInput().value).toBe("0000-0002-1825-0098");
    expect(identifierInput().getAttribute("aria-invalid")).toBe("true");
    expect(identifierInput().getAttribute("aria-describedby")).toContain("sw-authors-error");
    expect(document.activeElement).toBe(identifierInput());
    expect(names()).toEqual(["You"]);

    fireEvent.change(identifierInput(), { target: { value: "x" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses the same person twice", () => {
    render(<Harness />);
    addCoauthor(ADA);
    addCoauthor(ADA);
    expect(screen.getByRole("alert").textContent).toContain("is already on the list");
    expect(rows()).toHaveLength(2);
    addCoauthor(ME);
    expect(screen.getByRole("alert").textContent).toBe("That is you, and you are already listed.");
  });
});

describe("AuthorsStep — CRediT roles", () => {
  it("offers all fourteen roles to each author as toggles", () => {
    render(<Harness />);
    addCoauthor(ADA, "Ada");
    const group = within(rowFor("Ada")).getByRole("group", { name: "CRediT roles for Ada" });
    expect(within(group).getAllByRole("button")).toHaveLength(14);
    expect(role(rowFor("Ada"), "Conceptualization").getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles a role on and off, shows the choice in words, and keeps each author's roles apart", () => {
    render(<Harness />);
    addCoauthor(ADA, "Ada");
    const ada = rowFor("Ada");

    fireEvent.click(role(ada, "Software"));
    fireEvent.click(role(ada, "Conceptualization"));
    expect(role(ada, "Software").getAttribute("aria-pressed")).toBe("true");
    expect(ada.querySelector(".sw-roles__chosen")?.textContent).toBe("Conceptualization, Software");
    expect(rowFor("You").querySelector(".sw-roles__chosen")?.textContent).toBe("None chosen yet");

    fireEvent.click(role(ada, "Software"));
    expect(role(ada, "Software").getAttribute("aria-pressed")).toBe("false");
    expect(ada.querySelector(".sw-roles__chosen")?.textContent).toBe("Conceptualization");
  });

  it("explains each role to a screen reader", () => {
    render(<Harness />);
    expect(role(rowFor("You"), "Software").textContent).toContain("Programming, and implementing code");
  });
});

describe("AuthorsStep — order", () => {
  function three(): void {
    render(<Harness />);
    addCoauthor(ADA, "Ada");
    addCoauthor(GRACE, "Grace");
  }
  const move = (label: string, direction: "up" | "down"): void => {
    fireEvent.click(screen.getByRole("button", { name: `Move ${label} ${direction}` }));
  };

  it("numbers the byline and moves an author up or down", () => {
    three();
    expect(rows().map((li) => li.querySelector(".sw-author__position")?.textContent)).toEqual(["1", "2", "3"]);
    move("Grace", "up");
    expect(names()).toEqual(["You", "Grace", "Ada"]);
    move("You", "down");
    expect(names()).toEqual(["Grace", "You", "Ada"]);
    expect(announcement()).toBe("You is now author 2 of 3.");
  });

  it("disables the move that goes nowhere", () => {
    three();
    expect((screen.getByRole("button", { name: "Move You up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Grace down" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Ada up" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps focus on the button that was pressed, and hands it over at the end of the list", () => {
    three();
    move("Grace", "up");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Grace up" }));
    move("Grace", "up");
    // Grace is first now: Move up is disabled, so focus goes to Move down.
    expect(names()[0]).toBe("Grace");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Grace down" }));
  });

  it("carries roles with the author when they move", () => {
    three();
    fireEvent.click(role(rowFor("Grace"), "Methodology"));
    move("Grace", "up");
    expect(role(rowFor("Grace"), "Methodology").getAttribute("aria-pressed")).toBe("true");
  });

  it("removes a co-author and says so", () => {
    three();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ada" }));
    expect(names()).toEqual(["You", "Grace"]);
    expect(announcement()).toBe("Removed Ada.");
    expect(document.activeElement).toBe(identifierInput());
  });
});

describe("AuthorsStep — Continue", () => {
  it("names the first thing missing, and opens when every author has a role", () => {
    const onContinue = vi.fn();
    render(<Harness onContinue={onContinue} />);
    addCoauthor(ADA, "Ada");

    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Choose at least one CRediT role for You.")).toBeTruthy();

    fireEvent.click(role(rowFor("You"), "Conceptualization"));
    expect(screen.getByText("Choose at least one CRediT role for Ada.")).toBeTruthy();

    fireEvent.click(role(rowFor("Ada"), "Software"));
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0][0].map((a: DraftAuthor) => a.did)).toEqual([ME, ADA]);
  });

  it("stays closed with a reason when a co-author has no DID, and opens once they are removed", () => {
    render(<Harness onContinue={vi.fn()} />);
    addCoauthor("grace@example.org", "Grace");
    fireEvent.click(role(rowFor("You"), "Conceptualization"));
    fireEvent.click(role(rowFor("Grace"), "Software"));
    expect(continueButton().disabled).toBe(true);
    expect(
      screen.getByText("Grace is not matched to an account yet. Remove them, or add them by DID."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Grace" }));
    expect(continueButton().disabled).toBe(false);
  });

  it("asks the submitter to sign in when their own DID is unknown", () => {
    render(<Harness initial={initialAuthors()} onContinue={vi.fn()} />);
    expect(within(rowFor("You")).getByText("No DID yet")).toBeTruthy();
    fireEvent.click(role(rowFor("You"), "Conceptualization"));
    expect(continueButton().disabled).toBe(true);
    expect(screen.getAllByText(/Sign in so your own DID can be listed/).length).toBeGreaterThan(0);
  });

  it("stays closed, and says why, when there is no step 4 to go to", () => {
    render(<Harness />);
    fireEvent.click(role(rowFor("You"), "Conceptualization"));
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Step 4, Checks, is not open in this release yet.")).toBeTruthy();
  });

  it("offers a way back", () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Details" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("AuthorsStep — matching an ORCID iD or email to an account", () => {
  const found: AuthorLookup = { did: GRACE, name: "Grace Hopper" };

  it("without a lookup, says the co-author cannot be matched and to use a DID", () => {
    render(<Harness />);
    addCoauthor("grace@example.org");
    const row = rowFor("grace@example.org");
    expect(row.textContent).toContain("cannot be matched to an account yet");
    expect(within(row).queryByRole("button", { name: /Check again/ })).toBeNull();
  });

  it("with a lookup, shows it working and then the account it found", async () => {
    let finish: (value: AuthorLookup | null) => void = () => undefined;
    const resolveAuthor = vi.fn<ResolveAuthor>(
      () => new Promise<AuthorLookup | null>((resolve) => (finish = resolve)),
    );
    render(<Harness resolveAuthor={resolveAuthor} onContinue={vi.fn()} />);

    addCoauthor("grace@example.org");
    expect(resolveAuthor).toHaveBeenCalledWith({ kind: "email", value: "grace@example.org" });
    expect(within(rowFor("grace@example.org")).getByText("Looking for an account…")).toBeTruthy();
    expect(screen.getByText("Still looking for grace@example.org's account.")).toBeTruthy();
    expect(continueButton().disabled).toBe(true);

    await act(async () => finish(found));

    const row = rowFor("Grace Hopper");
    expect(within(row).getByText("Matched to an account")).toBeTruthy();
    expect(announcement()).toBe("Matched Grace Hopper to an account.");
  });

  it("does not look up a DID", () => {
    const resolveAuthor = vi.fn<ResolveAuthor>(async () => found);
    render(<Harness resolveAuthor={resolveAuthor} />);
    addCoauthor(ADA);
    expect(resolveAuthor).not.toHaveBeenCalled();
  });

  it("offers Check again when nothing was found, and when the lookup itself fails", async () => {
    const resolveAuthor = vi
      .fn<ResolveAuthor>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(found);
    render(<Harness resolveAuthor={resolveAuthor} />);

    addCoauthor(ORCID, "Grace");
    await waitFor(() => expect(within(rowFor("Grace")).getByText("Not matched")).toBeTruthy());
    expect(announcement()).toBe("No account found for Grace.");

    fireEvent.click(within(rowFor("Grace")).getByRole("button", { name: /Check again/ }));
    await waitFor(() => expect(resolveAuthor).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(rowFor("Grace")).getByText("Not matched")).toBeTruthy());

    fireEvent.click(within(rowFor("Grace")).getByRole("button", { name: /Check again/ }));
    await waitFor(() => expect(within(rowFor("Grace")).getByText("Matched to an account")).toBeTruthy());
  });

  it("folds a match into the existing row when that account is already listed", async () => {
    const resolveAuthor = vi.fn<ResolveAuthor>(async () => ({ did: ADA }));
    render(<Harness resolveAuthor={resolveAuthor} />);
    addCoauthor(ADA, "Ada");
    addCoauthor("ada@example.org");
    await waitFor(() => expect(names()).toEqual(["You", "Ada"]));
    expect(announcement()).toBe(
      "Ada is already on the list under a different identifier.",
    );
  });

  it("keeps two lookups that finish together", async () => {
    const resolvers: Record<string, (value: AuthorLookup | null) => void> = {};
    const resolveAuthor: ResolveAuthor = ({ value }) =>
      new Promise((resolve) => {
        resolvers[value] = resolve;
      });
    render(<Harness resolveAuthor={resolveAuthor} />);
    addCoauthor("ada@example.org", "Ada");
    addCoauthor("grace@example.org", "Grace");
    await act(async () => {
      resolvers["ada@example.org"]({ did: ADA });
      resolvers["grace@example.org"]({ did: GRACE });
    });
    expect(within(rowFor("Ada")).getByText("Matched to an account")).toBeTruthy();
    expect(within(rowFor("Grace")).getByText("Matched to an account")).toBeTruthy();
  });
});

describe("AuthorsStep — consent tracker", () => {
  const trackerRows = (): HTMLElement[] => within(screen.getByRole("region", { name: "Co-author consents" })).getAllByRole("listitem");

  it("shows every author as Waiting before a version exists", () => {
    render(<Harness />);
    addCoauthor(ADA, "Ada");
    const tracker = screen.getByRole("region", { name: "Co-author consents" });
    expect(within(tracker).getAllByText("Waiting")).toHaveLength(2);
    expect(within(tracker).queryByText("Signed")).toBeNull();
    expect(within(tracker).getByText("0 of 2 signed · 2 waiting")).toBeTruthy();
  });

  it("follows the byline as it changes", () => {
    render(<Harness />);
    addCoauthor(ADA, "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Move Ada up" }));
    expect(trackerRows().map((li) => li.querySelector(".sw-tracker__name")?.textContent)).toEqual(["Ada", "You"]);
  });

  it("shows Waiting, Signed and Declined from the node once a version exists", async () => {
    const fetcher = vi.fn(async () =>
      consentReport([
        [ME, "signed"],
        [ADA, "waiting"],
        [GRACE, "declined"],
      ]),
    );
    render(
      <Harness
        consentsFor={{ paper: "sch:abcd-efgh-ijkl", version: 1 }}
        fetchConsents={fetcher}
        pollMs={0}
      />,
    );

    expect(screen.getByText("Checking who has signed…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("1 of 3 signed · 1 waiting · 1 declined")).toBeTruthy());

    expect(fetcher).toHaveBeenCalledWith({ paper: "sch:abcd-efgh-ijkl", version: 1 }, expect.any(AbortSignal));
    const tracker = screen.getByRole("region", { name: "Co-author consents" });
    expect(within(tracker).getByText("Signed")).toBeTruthy();
    expect(within(tracker).getByText("Waiting")).toBeTruthy();
    expect(within(tracker).getByText("Declined")).toBeTruthy();
    expect(within(tracker).getByText(/declined authorship, so this version is back in draft/)).toBeTruthy();
    // The node's list decides who is shown; names come from the draft where it knows the DID.
    expect(trackerRows()[0].textContent).toContain("You");
    expect(screen.queryByText(/when you sign and submit/)).toBeNull();
  });

  it("says so when the node cannot be reached, and keeps the draft's list on show", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Harness consentsFor={{ paper: "sch:abcd-efgh-ijkl", version: 1 }} fetchConsents={fetcher} pollMs={0} />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not check who has signed. Trying again shortly."),
    );
    expect(trackerRows()).toHaveLength(1);
  });
});
