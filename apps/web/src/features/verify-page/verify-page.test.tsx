// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import { fileCid } from "../paper-proof/files";
import { TOAST_REGION_ID } from "../ui-kit";
import { parseManifestResponse, type LoadManifest, type VersionManifest } from "./manifest-source";
import { MATCH_HEADLINE, MISMATCH_HEADLINE } from "./verdict";
import { SIGNED_BYTES, VERSION_ID, fileOf, manifestBody } from "./verify-fixtures";
import { VerifyPage } from "./verify-page";
import type { VersionRef } from "./version-ref";

const MAIN = SIGNED_BYTES["main.pdf"];
const OTHER = new TextEncoder().encode("this is not what the authors signed");

/** A loader that answers for any version with the fixture manifest of that version. */
function fixtureLoader() {
  return vi.fn<LoadManifest>(async (ref: VersionRef) =>
    parseManifestResponse(manifestBody({ n: ref.version, version: ref.version }), ref),
  );
}

function renderPage(props: Partial<React.ComponentProps<typeof VerifyPage>> = {}) {
  const loadManifest = props.loadManifest ?? fixtureLoader();
  const view = render(<VerifyPage loadManifest={loadManifest} {...props} />);
  return { ...view, loadManifest: loadManifest as ReturnType<typeof fixtureLoader> };
}

const verdictOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".vp-verdict")!;
const kindOf = (container: HTMLElement) => verdictOf(container).dataset.kind;
const idInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>("#vp-id")!;
const fileInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="file"]')!;
const zone = (container: HTMLElement) => container.querySelector<HTMLElement>(".vp-drop")!;

function chooseFile(container: HTMLElement, file: File) {
  fireEvent.change(fileInput(container), { target: { files: [file] } });
}

const settled = (container: HTMLElement, kind: string) =>
  waitFor(() => expect(kindOf(container)).toBe(kind));

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  document.getElementById(TOAST_REGION_ID)?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("before a file is dropped", () => {
  it("asks for a version id and a file, and states no verdict", () => {
    const { container, loadManifest } = renderPage();

    expect(kindOf(container)).toBe("idle");
    expect(verdictOf(container).textContent).toBe("Enter a version id and drop a file to compare them.");
    expect(container.querySelector(".vp-verdict__headline")).toBeNull();
    expect(container.querySelector(".vp-verdict__icon")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("tells the reader up front that the file stays on their device", () => {
    const { container } = renderPage();
    expect(zone(container).textContent).toContain("Your file stays on this device");
    expect(zone(container).textContent).toContain("nothing is uploaded");
  });

  it("starts loading the signed files as soon as it is given a valid id, before any file", async () => {
    const { container, loadManifest } = renderPage({ initialId: VERSION_ID });

    expect(idInput(container).value).toBe(VERSION_ID);
    await waitFor(() => expect(loadManifest).toHaveBeenCalledTimes(1));
    expect(loadManifest.mock.calls[0][0]).toMatchObject({ schId: VERSION_ID });
    await waitFor(() =>
      expect(verdictOf(container).textContent).toBe(
        `Drop a file to compare it with the 2 files signed for ${VERSION_ID}.`,
      ),
    );
  });

  it("labels the id field and the hidden file input for assistive technology", () => {
    const { container, getByLabelText } = renderPage();
    expect(getByLabelText("Paper version")).toBe(idInput(container));
    expect(fileInput(container).getAttribute("aria-label")).toBe("File to check");
    expect(container.querySelector<HTMLButtonElement>(".vp-drop .vp-button")!.textContent).toBe("Choose a file");
  });
});

describe("a file that is one of the signed files", () => {
  it("is fingerprinted in the browser and reported as matching what the authors signed", async () => {
    const { container, loadManifest } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(MAIN, "main.pdf", "application/pdf"));
    await settled(container, "match");

    const verdict = verdictOf(container);
    expect(verdict.querySelector(".vp-verdict__headline")!.textContent).toBe(MATCH_HEADLINE);
    expect(verdict.dataset.tone).toBe("verified");
    expect(verdict.querySelector(".vp-verdict__summary")!.textContent).toBe(
      `It is main.pdf (manuscript), one of the 2 files signed for ${VERSION_ID}.`,
    );
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  it("is recognised under another name: only the contents are compared", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(MAIN, "Downloads copy (2).pdf"));
    await settled(container, "match");

    expect(verdictOf(container).textContent).toContain("it does not matter what yours is called");
  });

  it("shows the id it computed, which is the signed id, and marks the signed file it is", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");

    const details = container.querySelector<HTMLDetailsElement>("details")!;
    // Collapsed when all is well; the reader can open it to see why.
    expect(details.open).toBe(false);
    const copyLabels = Array.from(details.querySelectorAll<HTMLElement>(".vp-copy")).map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(copyLabels).toContain(`Copy your file's id: ${fileCid(MAIN)}`);

    const items = Array.from(details.querySelectorAll<HTMLElement>(".vp-signed__item"));
    expect(items.map((item) => item.dataset.same)).toEqual(["true", "false"]);
    expect(items[0].textContent).toContain("Same as your file");
    expect(items[1].textContent).not.toContain("Same as your file");
  });

  it("links to the Proof page, which checks the signatures this page does not", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });
    expect(container.querySelector(".vp-proof")).toBeNull();

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");

    const link = container.querySelector<HTMLAnchorElement>(".vp-proof a")!;
    expect(link.getAttribute("href")).toBe("/proof/6sel-2dio-orm6/v2");
    expect(container.querySelector(".vp-proof")!.textContent).toContain("To check the signatures themselves");
  });
});

describe("a file that is not one of the signed files", () => {
  it("says This file does not match what the authors signed", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(OTHER, "notes.txt", "text/plain"));
    await settled(container, "mismatch");

    const verdict = verdictOf(container);
    expect(verdict.querySelector(".vp-verdict__headline")!.textContent).toBe(
      "This file does not match what the authors signed",
    );
    expect(MISMATCH_HEADLINE).toBe("This file does not match what the authors signed");
    expect(verdict.dataset.tone).toBe("critical");
    expect(verdict.querySelector(".vp-verdict__summary")!.textContent).toContain("Do not rely on it");
    expect(verdict.textContent).not.toContain("matches what the authors signed");
  });

  it("catches a file that differs from a signed file by one byte", async () => {
    const edited = Uint8Array.from(MAIN);
    edited[0] ^= 0xff;
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(edited, "main.pdf"));
    await settled(container, "mismatch");

    expect(verdictOf(container).textContent).toContain("main.pdf is signed for this version");
  });

  it("opens the technical details, so the reader can see both ids", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(OTHER, "notes.txt"));
    await settled(container, "mismatch");

    const details = container.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Files signed for " + VERSION_ID);
    expect(details.textContent).toContain("main.pdf");
    expect(details.textContent).toContain("data/results.csv");
    expect(details.querySelector('[data-same="true"]')).toBeNull();
    expect(details.textContent).not.toContain("Same as your file");
  });

  it("treats an empty file as a file like any other", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(new Uint8Array(), "empty.txt"));
    await settled(container, "mismatch");

    expect(container.querySelector<HTMLDetailsElement>("details")!.textContent).toContain("0 B");
  });

  it("ignores a file that finishes being read after the reader chose another", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    // The first file is slow to read: its bytes arrive only when we say so.
    let arrive!: (bytes: ArrayBuffer) => void;
    const slow = fileOf(MAIN, "main.pdf");
    Object.defineProperty(slow, "slice", {
      value: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (arrive = resolve)) }),
    });
    chooseFile(container, slow);
    await waitFor(() => expect(kindOf(container)).toBe("checking"));

    // The reader chooses another file, which is quick, and gets its verdict.
    chooseFile(container, fileOf(OTHER, "notes.txt"));
    await settled(container, "mismatch");

    // The first file's bytes now arrive. They would make it a match; they must not be shown.
    arrive(MAIN.buffer.slice(MAIN.byteOffset, MAIN.byteOffset + MAIN.byteLength) as ArrayBuffer);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kindOf(container)).toBe("mismatch");
    expect(zone(container).textContent).toContain("notes.txt");
  });

  it("changes its answer when a different file replaces the first", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(OTHER, "notes.txt"));
    await settled(container, "mismatch");

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");
    expect(container.querySelectorAll(".vp-verdict__headline")).toHaveLength(1);
    expect(zone(container).textContent).toContain("main.pdf");
    expect(zone(container).querySelector(".vp-button")!.textContent).toBe("Choose a different file");
  });
});

describe("the order the reader does things in", () => {
  it("compares a file dropped before the id was entered, once the id arrives", async () => {
    const { container, loadManifest } = renderPage();

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await waitFor(() => expect(verdictOf(container).textContent).toContain("Could not check"));
    expect(loadManifest).not.toHaveBeenCalled();

    fireEvent.change(idInput(container), { target: { value: VERSION_ID } });
    await settled(container, "match");
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  it("compares again when the id is changed to another version", async () => {
    // Version 2 lists the file; version 3 does not.
    const loadManifest = vi.fn<LoadManifest>(async (ref) =>
      parseManifestResponse(
        manifestBody({
          n: ref.version,
          version: ref.version,
          files: ref.version === 2 ? manifestBody().files : (manifestBody().files as unknown[]).slice(1),
        }),
        ref,
      ),
    );
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");

    fireEvent.change(idInput(container), { target: { value: "sch:6sel-2dio-orm6/v3" } });
    await settled(container, "mismatch");
    expect(verdictOf(container).textContent).toContain("sch:6sel-2dio-orm6/v3");
  });

  it("never uses the signed list of a version the reader has since left", async () => {
    const pending: Array<{ ref: VersionRef; signal?: AbortSignal; resolve: (m: VersionManifest) => void }> = [];
    const loadManifest = vi.fn<LoadManifest>(
      (ref, signal) => new Promise((resolve) => pending.push({ ref, signal, resolve })),
    );
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });
    await waitFor(() => expect(pending).toHaveLength(1));

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    fireEvent.change(idInput(container), { target: { value: "sch:6sel-2dio-orm6/v3" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal!.aborted).toBe(true);

    // Version 2's list (which holds the file) arrives late. Version 3's does not hold it.
    pending[0].resolve(parseManifestResponse(manifestBody(), pending[0].ref));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kindOf(container)).toBe("checking");

    pending[1].resolve(
      parseManifestResponse(
        manifestBody({ n: 3, version: 3, files: (manifestBody().files as unknown[]).slice(1) }),
        pending[1].ref,
      ),
    );
    await settled(container, "mismatch");
  });
});

describe("the version id field", () => {
  it("does not scold a half-typed id, but says what is wrong once the field is left", () => {
    const { container, loadManifest } = renderPage();
    const input = idInput(container);

    fireEvent.change(input, { target: { value: "sch:6sel-2dio" } });
    expect(container.querySelector(".vp-error")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");

    fireEvent.blur(input);
    const error = container.querySelector(".vp-error")!;
    expect(error.textContent).toContain("That is not a version id");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(`vp-id-help ${error.id}`);
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("hides the sentence again while the reader edits the field, and restores it on leaving", () => {
    const { container } = renderPage();
    const input = idInput(container);
    fireEvent.change(input, { target: { value: "sch:6sel-2dio" } });
    fireEvent.blur(input);
    expect(container.querySelector(".vp-error")).not.toBeNull();

    // Editing: each half-typed id would otherwise be scolded in turn.
    fireEvent.change(input, { target: { value: "sch:6sel-2dio-orm" } });
    expect(container.querySelector(".vp-error")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");

    fireEvent.blur(input);
    expect(container.querySelector(".vp-error")).not.toBeNull();
  });

  it("stops scolding a link's bad id as soon as the reader starts to fix it", () => {
    const { container } = renderPage({ initialId: "nonsense" });
    expect(container.querySelector(".vp-error")).not.toBeNull();

    fireEvent.change(idInput(container), { target: { value: "sch:6sel-2dio-orm6/v" } });

    expect(container.querySelector(".vp-error")).toBeNull();
  });

  it("drops the sentence as soon as the id becomes usable, and loads its files", async () => {
    const { container, loadManifest } = renderPage();
    const input = idInput(container);
    fireEvent.change(input, { target: { value: "sch:6sel-2dio-orm7/v2" } });
    fireEvent.blur(input);
    expect(container.querySelector(".vp-error")!.textContent).toContain("checksum");

    fireEvent.change(input, { target: { value: VERSION_ID } });

    expect(container.querySelector(".vp-error")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("vp-id-help");
    await waitFor(() => expect(loadManifest).toHaveBeenCalledTimes(1));
  });

  it("asks for the version when only the paper is named", () => {
    const { container } = renderPage({ initialId: "sch:6sel-2dio-orm6" });
    expect(container.querySelector(".vp-error")!.textContent).toContain("Add the version");
  });

  it("says what is wrong with a bad id that arrived in the link", () => {
    const { container } = renderPage({ initialId: "nonsense" });
    expect(container.querySelector(".vp-error")!.textContent).toContain("That is not a version id");
  });

  it("points out a bad id when a file is dropped before it was fixed", async () => {
    const { container } = renderPage();
    fireEvent.change(idInput(container), { target: { value: "sch:6sel" } });
    expect(container.querySelector(".vp-error")).toBeNull();

    chooseFile(container, fileOf(MAIN, "main.pdf"));

    expect(container.querySelector(".vp-error")).not.toBeNull();
  });

  it("does not reload the page when Enter is pressed in the field", () => {
    const { container } = renderPage();
    const form = container.querySelector("form")!;
    const notPrevented = fireEvent.submit(form);
    expect(notPrevented).toBe(false);
  });
});

describe("when the signed files cannot be had", () => {
  it("is 'Could not check', in grey, and not a statement about the file", async () => {
    const loadManifest = vi.fn<LoadManifest>(async () => {
      throw new ApiError(404, { status: 404, title: "Not Found" });
    });
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "cannot_check");

    const verdict = verdictOf(container);
    expect(verdict.querySelector(".vp-verdict__headline")!.textContent).toBe("Could not check");
    expect(verdict.dataset.tone).toBe("neutral");
    expect(verdict.textContent).toContain(`This node has no published ${VERSION_ID}`);
    expect(verdict.textContent).toContain("does not mean the file is wrong");
    expect(verdict.textContent).not.toContain(MISMATCH_HEADLINE);
    expect(container.querySelector(".vp-proof")).toBeNull();
  });

  it("offers Try again, which asks the node once more and then compares", async () => {
    const loadManifest = vi
      .fn<LoadManifest>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(async (ref) => parseManifestResponse(manifestBody(), ref));
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });
    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "cannot_check");

    fireEvent.click(verdictOf(container).querySelector<HTMLButtonElement>(".vp-button")!);

    await settled(container, "match");
    expect(loadManifest).toHaveBeenCalledTimes(2);
  });

  it("is 'Could not check' when the node answers for a different version", async () => {
    const loadManifest = vi.fn<LoadManifest>(async (ref) =>
      parseManifestResponse(manifestBody({ n: 5, version: 5 }), ref),
    );
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "cannot_check");
    expect(verdictOf(container).textContent).toContain("different version");
  });
});

describe("a file that cannot be read", () => {
  it("is 'Could not read this file', never a mismatch", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });
    const gone = fileOf(MAIN, "gone.pdf");
    // The browser lost the file after it was chosen: reading any part of it fails.
    Object.defineProperty(gone, "slice", {
      value: () => ({ arrayBuffer: () => Promise.reject(new Error("NotFoundError")) }),
    });

    chooseFile(container, gone);
    await settled(container, "cannot_check");

    expect(verdictOf(container).querySelector(".vp-verdict__headline")!.textContent).toBe("Could not read this file");
    expect(verdictOf(container).textContent).toContain("moved or deleted");
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("the drop zone", () => {
  const drop = (container: HTMLElement, dataTransfer: Record<string, unknown>) =>
    fireEvent.drop(zone(container), { dataTransfer });

  it("checks a file that is dropped on it", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    drop(container, { files: [fileOf(MAIN, "main.pdf")], items: [], types: ["Files"] });

    await settled(container, "match");
  });

  it("highlights while a file is dragged over it, and stops when it leaves or drops", () => {
    const { container } = renderPage();
    const over = { dataTransfer: { types: ["Files"], files: [], items: [] } };

    fireEvent.dragEnter(zone(container), over);
    expect(zone(container).dataset.dragging).toBe("true");
    fireEvent.dragLeave(zone(container), over);
    expect(zone(container).dataset.dragging).toBeUndefined();

    fireEvent.dragEnter(zone(container), over);
    fireEvent.drop(zone(container), over);
    expect(zone(container).dataset.dragging).toBeUndefined();
  });

  it("ignores a drag that carries text, not files", () => {
    const { container } = renderPage();
    fireEvent.dragEnter(zone(container), { dataTransfer: { types: ["text/plain"], files: [], items: [] } });
    expect(zone(container).dataset.dragging).toBeUndefined();
  });

  it("checks the first of several files and says the others were not checked", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    drop(container, {
      files: [fileOf(MAIN, "main.pdf"), fileOf(OTHER, "notes.txt")],
      items: [],
      types: ["Files"],
    });

    await settled(container, "match");
    expect(zone(container).querySelector(".vp-drop__notice")!.textContent).toBe(
      "You dropped 2 files. Checking main.pdf; drop the others one at a time.",
    );
  });

  it("names a dropped folder instead of checking it", async () => {
    const { container, loadManifest } = renderPage({ initialId: VERSION_ID });
    await waitFor(() => expect(loadManifest).toHaveBeenCalled());

    drop(container, {
      files: [],
      items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true, name: "bundle" }) }],
      types: ["Files"],
    });

    expect(zone(container).querySelector(".vp-drop__notice")!.textContent).toContain("bundle is a folder");
    // No file was taken: still a hint, with nothing read and no verdict.
    expect(kindOf(container)).toBe("idle");
    expect(container.querySelector("details")).toBeNull();
    expect(zone(container).querySelector(".vp-button")!.textContent).toBe("Choose a file");
  });

  it("has a real button for the picker, so the page works without dragging", () => {
    const { container } = renderPage();
    const click = vi.spyOn(fileInput(container), "click").mockImplementation(() => undefined);

    fireEvent.click(zone(container).querySelector(".vp-button")!);

    expect(click).toHaveBeenCalledTimes(1);
    expect(zone(container).querySelector(".vp-button")!.getAttribute("aria-describedby")).toBe("vp-privacy");
  });
});

describe("what leaves the device", () => {
  it("is one GET for the signed list: the file, its name and its bytes are never sent", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(manifestBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // No `loadManifest`: the page's own loader, against a stubbed network.
    const { container } = render(<VerifyPage initialId={VERSION_ID} />);
    chooseFile(container, fileOf(MAIN, "my-private-draft.pdf"));
    await settled(container, "match");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(String(url)).toMatch(/\/v1\/papers\/sch%3A6sel-2dio-orm6\/v\/2\/manifest$/);
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init?.body ?? undefined).toBeUndefined();
    expect(JSON.stringify([...fetchMock.mock.calls])).not.toContain("my-private-draft");
  });
});

describe("accessibility", () => {
  it("keeps one live region from the first hint to the verdict, so the verdict is announced", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });
    const region = verdictOf(container);
    expect(region.getAttribute("role")).toBe("status");

    chooseFile(container, fileOf(OTHER, "notes.txt"));
    await settled(container, "mismatch");

    expect(verdictOf(container)).toBe(region);
  });

  it("is busy while it checks and not after", async () => {
    let release!: (manifest: VersionManifest) => void;
    let asked!: VersionRef;
    const loadManifest = vi.fn<LoadManifest>(
      (ref) =>
        new Promise((resolve) => {
          asked = ref;
          release = resolve;
        }),
    );
    const { container } = renderPage({ initialId: VERSION_ID, loadManifest });
    const result = container.querySelector<HTMLElement>(".vp-result")!;
    expect(result.getAttribute("aria-busy")).toBe("false");

    // The file is read, but the signed list has not arrived: still checking.
    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "checking");
    expect(result.getAttribute("aria-busy")).toBe("true");
    expect(verdictOf(container).querySelector(".vp-verdict__headline")!.textContent).toBe("Checking…");

    release(parseManifestResponse(manifestBody(), asked));
    await settled(container, "match");
    expect(result.getAttribute("aria-busy")).toBe("false");
  });

  it("gives every state words and an icon of its own shape, so colour is never the only signal", async () => {
    const shape = (container: HTMLElement) =>
      verdictOf(container).querySelector(".vp-verdict__icon")!.innerHTML;

    const matched = renderPage({ initialId: VERSION_ID });
    chooseFile(matched.container, fileOf(MAIN, "main.pdf"));
    await settled(matched.container, "match");
    const tick = shape(matched.container);
    cleanup();

    const mismatched = renderPage({ initialId: VERSION_ID });
    chooseFile(mismatched.container, fileOf(OTHER, "notes.txt"));
    await settled(mismatched.container, "mismatch");

    expect(shape(mismatched.container)).not.toBe(tick);
    expect(verdictOf(mismatched.container).querySelector(".vp-verdict__icon")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("copying", () => {
  it("copies the file's id on click and confirms with the Copied toast", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });
    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="Copy your file's id: ${fileCid(MAIN)}"]`)!;

    fireEvent.click(button);

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(fileCid(MAIN)));
    await waitFor(() => expect(document.getElementById(TOAST_REGION_ID)!.textContent).toContain("Copied"));
  });
});

describe("under React StrictMode", () => {
  it("still loads the signed list and reaches the verdict once", async () => {
    const loadManifest = fixtureLoader();
    const { container } = render(
      <StrictMode>
        <VerifyPage initialId={VERSION_ID} loadManifest={loadManifest} />
      </StrictMode>,
    );

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");
    expect(container.querySelectorAll(".vp-verdict__headline")).toHaveLength(1);
  });
});
