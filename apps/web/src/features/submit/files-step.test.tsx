// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MIB } from "./limits";
import { FilesStep, type FilesStepProps } from "./files-step";
import type { UploadFailure } from "./tus-upload";
import type { ManagerDeps } from "./upload-manager";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

afterEach(cleanup);

/** A File whose reported size is `size`, without allocating that many bytes. */
function makeFile(name: string, size = 1000, type = ""): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

interface FakeUpload {
  file: File;
  callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2];
  stop: ReturnType<typeof vi.fn>;
}

/** The step wired to a fake uploader and fingerprinter that the test drives by hand. */
function renderStep(props: Partial<FilesStepProps> = {}) {
  const uploads: FakeUpload[] = [];
  const hashes: {
    file: File;
    progress: (hashed: number, total: number) => void;
    resolve: (cid: string) => void;
  }[] = [];
  const managerDeps: ManagerDeps = {
    startUpload: (file, _init, callbacks) => {
      const stop = vi.fn(async () => undefined);
      uploads.push({ file, callbacks, stop });
      return { stop };
    },
    fingerprint: (file, options) =>
      new Promise<string>((resolve) => {
        hashes.push({ file: file as File, progress: (h, t) => options?.onProgress?.(h, t), resolve });
      }),
  };
  const view = render(<FilesStep managerDeps={managerDeps} {...props} />);
  return { ...view, uploads, hashes };
}

const zone = (title: string): HTMLElement =>
  screen.getByRole("heading", { name: title }).closest(".sw-drop") as HTMLElement;

const drop = (target: HTMLElement, files: File[], extra: Record<string, unknown> = {}) =>
  fireEvent.drop(target, { dataTransfer: { files, items: [], types: ["Files"], ...extra } });

const choose = (label: string, files: File[]) =>
  fireEvent.change(screen.getByLabelText(label), { target: { files } });

/** Run `fn` the way a real event would: inside act, so React renders what it changes. */
const run = (fn: () => void) => act(fn);

/** The file-name cell of a row (the name also appears in screen-reader-only button labels). */
const fileName = (name: string): HTMLElement => screen.getByText(name, { selector: ".sw-file__name" });
const queryFileName = (name: string): HTMLElement | null => screen.queryByText(name, { selector: ".sw-file__name" });


async function finish(
  view: ReturnType<typeof renderStep>,
  index = 0,
  cid = CID,
): Promise<void> {
  await act(async () => {
    view.uploads[index].callbacks.onSuccess({ cid, url: null });
    view.hashes[index].resolve(cid);
  });
}

const networkFailure: UploadFailure = {
  kind: "network",
  status: null,
  message: "The connection was lost. The upload will continue from where it stopped.",
  retryable: true,
};

describe("FilesStep — what the author sees before adding anything", () => {
  it("states the size limits up front", () => {
    renderStep();
    const limits = screen.getByRole("complementary", { name: "Size limits" });
    expect(within(limits).getByText("PDF")).toBeTruthy();
    expect(within(limits).getByText("up to 50 MB")).toBeTruthy();
    expect(within(limits).getByText("LaTeX source, code and data")).toBeTruthy();
    expect(within(limits).getByText("up to 5 GB per file")).toBeTruthy();
  });

  it("says uploads are resumable and fingerprinted on the device", () => {
    renderStep();
    expect(screen.getByText(/Uploads are resumable/)).toBeTruthy();
    expect(screen.getByText(/fingerprinted on your device/)).toBeTruthy();
  });

  it("offers a drop zone for the paper and one for code and data, each with its own limit", () => {
    renderStep();
    expect(within(zone("Paper")).getByText(/PDF and\/or LaTeX source/)).toBeTruthy();
    expect(within(zone("Paper")).getByText(/PDF up to 50 MB/)).toBeTruthy();
    expect(within(zone("Code and data (optional)")).getByText(/Up to 5 GB per file/)).toBeTruthy();
  });

  it("has a keyboard-reachable button to pick files in each zone", () => {
    renderStep();
    expect(within(zone("Paper")).getByRole("button", { name: /Choose files/ })).toBeTruthy();
    expect(within(zone("Code and data (optional)")).getByRole("button", { name: /Choose files/ })).toBeTruthy();
  });

  it("starts with no files and the Continue button closed, saying why", () => {
    renderStep({ onContinue: vi.fn() });
    expect(screen.getByRole("status").textContent).toBe("No files added yet.");
    const button = screen.getByRole("button", { name: "Continue to Details" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Add your paper as a PDF or LaTeX source to continue.")).toBeTruthy();
  });
});

describe("FilesStep — adding files", () => {
  it("accepts a PDF chosen with the picker and shows it uploading with both progress bars", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf", 2 * MIB, "application/pdf")]);

    expect(fileName("paper.pdf")).toBeTruthy();
    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(screen.getByText("2.0 MB")).toBeTruthy();
    expect((screen.getByLabelText("Role of paper.pdf") as HTMLSelectElement).value).toBe("pdf");
    expect(screen.getByLabelText("Fingerprint progress for paper.pdf")).toBeTruthy();
    expect(screen.getByLabelText("Upload progress for paper.pdf")).toBeTruthy();
    expect(view.uploads).toHaveLength(1);
  });

  it("accepts files dragged onto a drop zone", () => {
    const view = renderStep();
    drop(zone("Paper"), [makeFile("main.tex"), makeFile("refs.bib")]);

    expect(fileName("main.tex")).toBeTruthy();
    expect(fileName("refs.bib")).toBeTruthy();
    expect(view.uploads).toHaveLength(2);
    expect((screen.getByLabelText("Role of main.tex") as HTMLSelectElement).value).toBe("source");
  });

  it("files code and data dropped in the second zone by what they are", () => {
    renderStep();
    drop(zone("Code and data (optional)"), [makeFile("run.py"), makeFile("table.csv")]);
    expect((screen.getByLabelText("Role of run.py") as HTMLSelectElement).value).toBe("code");
    expect((screen.getByLabelText("Role of table.csv") as HTMLSelectElement).value).toBe("data");
  });

  it("highlights the zone while files are dragged over it, and stops when they leave", () => {
    renderStep();
    const paper = zone("Paper");
    fireEvent.dragEnter(paper, { dataTransfer: { types: ["Files"] } });
    expect(paper.getAttribute("data-dragging")).toBe("true");
    fireEvent.dragLeave(paper);
    expect(paper.getAttribute("data-dragging")).toBeNull();
  });

  it("does not highlight for a drag that carries no files (selected text, say)", () => {
    renderStep();
    const paper = zone("Paper");
    fireEvent.dragEnter(paper, { dataTransfer: { types: ["text/plain"] } });
    expect(paper.getAttribute("data-dragging")).toBeNull();
  });

  it("lets the same file be chosen again after it was removed", () => {
    renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove paper.pdf" }));
    expect(queryFileName("paper.pdf")).toBeNull();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    expect(fileName("paper.pdf")).toBeTruthy();
  });

  it("tells the author folders cannot be uploaded and names them", () => {
    renderStep();
    const entry = (name: string, isDirectory: boolean) => ({ webkitGetAsEntry: () => ({ name, isDirectory }), kind: "file" });
    drop(zone("Code and data (optional)"), [makeFile("data"), makeFile("run.py")], {
      items: [entry("data", true), entry("run.py", false)],
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Folders cannot be uploaded as they are \(data\)/);
    expect(alert.textContent).toMatch(/\.zip or \.tar\.gz/);
    expect(fileName("run.py")).toBeTruthy();
    expect(queryFileName("data")).toBeNull();
  });
});

describe("FilesStep — files that are not added", () => {
  it("lists an oversized PDF as Not added with the exact sizes, and lets it be dismissed", () => {
    const view = renderStep();
    drop(zone("Paper"), [makeFile("huge.pdf", 50 * MIB + 1, "application/pdf")]);

    expect(screen.getByText("Not added")).toBeTruthy();
    expect(screen.getByText(/52,428,801 bytes/)).toBeTruthy();
    expect(screen.getByText(/at most 50\.0 MB \(52,428,800 bytes\)/)).toBeTruthy();
    expect(view.uploads).toHaveLength(0);
    expect(screen.queryByLabelText("Upload progress for huge.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss huge.pdf" }));
    expect(queryFileName("huge.pdf")).toBeNull();
  });

  it("explains a file the paper zone does not take", () => {
    renderStep();
    drop(zone("Paper"), [makeFile("results.csv")]);
    expect(screen.getByText("Not added")).toBeTruthy();
    expect(screen.getByText(/Add anything else under Code and data/)).toBeTruthy();
  });

  it("does not let a rejected file block Continue", async () => {
    const onContinue = vi.fn();
    const view = renderStep({ onContinue });
    drop(zone("Paper"), [makeFile("paper.pdf"), makeFile("results.csv")]);
    await finish(view);
    expect((screen.getByRole("button", { name: "Continue to Details" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("FilesStep — progress", () => {
  it("shows the fingerprint and the upload advancing independently", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf", 1000)]);

    run(() => view.hashes[0].progress(400, 1000));
    run(() => view.uploads[0].callbacks.onProgress(250, 1000));

    expect((screen.getByLabelText("Fingerprint progress for paper.pdf") as HTMLProgressElement).value).toBe(40);
    expect((screen.getByLabelText("Upload progress for paper.pdf") as HTMLProgressElement).value).toBe(25);
    expect(screen.getByText("40%")).toBeTruthy();
    expect(screen.getByText("25% · 250 B of 1000 B")).toBeTruthy();
  });

  it("shows Reconnecting when the connection drops, then Uploading again", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);

    run(() => view.uploads[0].callbacks.onRetrying?.(0));
    expect(screen.getByText("Reconnecting")).toBeTruthy();
    expect(screen.getByText(/Connection lost · will continue from 0%/)).toBeTruthy();

    run(() => view.uploads[0].callbacks.onProgress(100, 1000));
    expect(screen.getByText("Uploading")).toBeTruthy();
  });

  it("says when an earlier upload of the same file is being continued", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() => view.uploads[0].callbacks.onResumed?.());
    expect(screen.getByText("Continuing an earlier upload of this file.")).toBeTruthy();
  });

  it("counts finished files in a status line", async () => {
    const view = renderStep();
    drop(zone("Paper"), [makeFile("a.pdf"), makeFile("b.pdf")]);
    expect(screen.getByRole("status").textContent).toBe("0 of 2 files uploaded");
    await finish(view, 0);
    expect(screen.getByRole("status").textContent).toBe("1 of 2 files uploaded");
  });
});

describe("FilesStep — a finished upload", () => {
  it("shows Uploaded, the file's fingerprint, and that it matches the copy on the node", async () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf", 1000, "application/pdf")]);
    await finish(view);

    expect(screen.getByText("Uploaded")).toBeTruthy();
    const fingerprint = screen.getByText("bafkreihdwdc…vyku");
    expect(fingerprint.getAttribute("title")).toBe(CID);
    expect(screen.getByText(/matches the copy on the node/)).toBeTruthy();
    expect((screen.getByLabelText("Fingerprint progress for paper.pdf") as HTMLProgressElement).value).toBe(100);
    expect((screen.getByLabelText("Upload progress for paper.pdf") as HTMLProgressElement).value).toBe(100);
  });

  it("shows Checking while the node has the file but its fingerprint is not ready", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() => view.uploads[0].callbacks.onSuccess({ cid: CID, url: null }));
    expect(screen.getByText("Checking")).toBeTruthy();
  });

  it("fails, saying so, when the node's copy does not match", async () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    await finish(view, 0, CID);
    // A second file whose server CID differs from its fingerprint.
    drop(zone("Paper"), [makeFile("other.pdf")]);
    await act(async () => {
      view.uploads[1].callbacks.onSuccess({ cid: "bafkreiother", url: null });
      view.hashes[1].resolve(CID);
    });

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/does not match this file's fingerprint/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry other.pdf" })).toBeTruthy();
  });
});

describe("FilesStep — controls", () => {
  it("pauses and resumes an upload, naming the file on each button", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);

    fireEvent.click(screen.getByRole("button", { name: "Pause paper.pdf" }));
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(view.uploads[0].stop).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Pause paper.pdf" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume paper.pdf" }));
    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(view.uploads).toHaveLength(2);
  });

  it("shows why an upload failed and retries it", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() => view.uploads[0].callbacks.onFailure(networkFailure));

    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(networkFailure.message)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry paper.pdf" }));
    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(view.uploads).toHaveLength(2);
  });

  it("offers no Retry when the server said the file is too large", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() =>
      view.uploads[0].callbacks.onFailure({
        kind: "too-large",
        status: 413,
        message: "PDF uploads are limited to 50 MiB.",
        retryable: false,
      }),
    );
    expect(screen.getByText("PDF uploads are limited to 50 MiB.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove paper.pdf" })).toBeTruthy();
  });

  it("removes a file and stops its work", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Remove paper.pdf" }));
    expect(queryFileName("paper.pdf")).toBeNull();
    expect(view.uploads[0].stop).toHaveBeenCalled();
  });

  it("lets the author change a file's role from the menu, offering the paper-PDF role only for PDFs", () => {
    renderStep();
    drop(zone("Paper"), [makeFile("paper.pdf"), makeFile("main.tex")]);

    const tex = screen.getByLabelText("Role of main.tex") as HTMLSelectElement;
    expect(Array.from(tex.options).map((o) => o.textContent)).toEqual(["LaTeX source", "Code", "Data"]);
    fireEvent.change(tex, { target: { value: "code" } });
    expect(tex.value).toBe("code");

    const pdf = screen.getByLabelText("Role of paper.pdf") as HTMLSelectElement;
    expect(Array.from(pdf.options).map((o) => o.textContent)).toContain("Paper PDF");
  });
});

describe("FilesStep — continuing", () => {
  it("opens Continue once the paper is on the node and matches, and hands over the files", async () => {
    const onContinue = vi.fn();
    const view = renderStep({ onContinue });
    choose("Choose paper files", [makeFile("paper.pdf", 1000, "application/pdf")]);

    const button = screen.getByRole("button", { name: "Continue to Details" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Wait for the uploads and fingerprints to finish.")).toBeTruthy();

    await finish(view);
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith([
      { id: "file-1", path: "paper.pdf", size: 1000, mediaType: "application/pdf", role: "pdf", cid: CID },
    ]);
  });

  it("stays closed while a file has failed, and says to retry or remove it", () => {
    const view = renderStep({ onContinue: vi.fn() });
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() => view.uploads[0].callbacks.onFailure(networkFailure));
    expect(screen.getByText("Retry or remove the files that failed.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue to Details" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays closed when there is nowhere to go next, and says so", async () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    await finish(view);
    expect((screen.getByRole("button", { name: "Continue to Details" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Step 2, Details, is not open in this release yet.")).toBeTruthy();
  });

  it("reports the finished files when that set changes, not on every progress tick", async () => {
    const onFilesChange = vi.fn();
    const view = renderStep({ onFilesChange });
    expect(onFilesChange).toHaveBeenLastCalledWith([]);
    onFilesChange.mockClear();

    choose("Choose paper files", [makeFile("paper.pdf", 1000, "application/pdf")]);
    run(() => view.uploads[0].callbacks.onProgress(100, 1000));
    run(() => view.uploads[0].callbacks.onProgress(500, 1000));
    expect(onFilesChange).not.toHaveBeenCalled();

    await finish(view);
    expect(onFilesChange).toHaveBeenCalledTimes(1);
    expect(onFilesChange.mock.calls[0][0]).toEqual([
      { id: "file-1", path: "paper.pdf", size: 1000, mediaType: "application/pdf", role: "pdf", cid: CID },
    ]);
  });
});

describe("FilesStep — the page around it", () => {
  it("asks the browser to confirm leaving while an upload is running, and not otherwise", () => {
    renderStep();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);

    choose("Choose paper files", [makeFile("paper.pdf")]);
    expect(leave()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Pause paper.pdf" }));
    expect(leave()).toBe(false);
  });

  it("stops the browser from opening a file dropped outside the zones, which would end the upload", () => {
    renderStep();
    const stray = new Event("drop", { cancelable: true, bubbles: true });
    Object.defineProperty(stray, "dataTransfer", { value: { types: ["Files"] } });
    document.body.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(true);

    const text = new Event("drop", { cancelable: true, bubbles: true });
    Object.defineProperty(text, "dataTransfer", { value: { types: ["text/plain"] } });
    document.body.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });

  it("restarts uploads that lost their connection when the browser comes back online", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    run(() => view.uploads[0].callbacks.onFailure(networkFailure));
    expect(screen.getByText("Failed")).toBeTruthy();

    run(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(view.uploads).toHaveLength(2);
  });

  it("stops every upload when the page is closed", () => {
    const view = renderStep();
    choose("Choose paper files", [makeFile("paper.pdf")]);
    view.unmount();
    expect(view.uploads[0].stop).toHaveBeenCalled();
  });
});
