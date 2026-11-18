// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOAST_REGION_ID } from "../ui-kit";
import { parseManifestResponse, type LoadManifest, type VersionManifest } from "./manifest-source";
import { useFileCheck } from "./use-file-check";
import { SIGNED_BYTES, VERSION_ID, fileOf, manifestBody } from "./verify-fixtures";
import { VerifyPage } from "./verify-page";
import type { VersionRef } from "./version-ref";

const MAIN = SIGNED_BYTES["main.pdf"];

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

describe("bugfix: dropping an archive clears a previous verdict", () => {
  it("does not keep the previous file's verdict when a .car is dropped after it", async () => {
    const { container } = renderPage({ initialId: VERSION_ID });

    chooseFile(container, fileOf(MAIN, "main.pdf"));
    await settled(container, "match");

    chooseFile(container, fileOf(new TextEncoder().encode("an exported paper"), "sch-6sel-2dio-orm6.car"));

    await waitFor(() => expect(kindOf(container)).toBe("idle"));
    expect(zone(container).textContent).toContain("Drop a file here");
    expect(zone(container).textContent).not.toContain("main.pdf");
    expect(zone(container).querySelector(".vp-drop__notice")!.textContent).toContain("paper archive");
  });
});

describe("bugfix: /verify manifest is not re-requested when the loader changes identity", () => {
  it("requests the manifest once even when loadManifest is a new function on every render, and once more after retry", async () => {
    const spy = vi.fn<LoadManifest>(async (ref: VersionRef) =>
      parseManifestResponse(manifestBody({ n: ref.version, version: ref.version }), ref),
    );

    const { result, rerender } = renderHook(
      ({ loadManifest }: { loadManifest: LoadManifest }) =>
        useFileCheck({ initialId: VERSION_ID, loadManifest }),
      { initialProps: { loadManifest: ((ref, signal) => spy(ref, signal)) as LoadManifest } },
    );

    // Re-render several times, each with a fresh loader identity (as an inline
    // arrow in a re-rendering parent would), without changing the id.
    for (let i = 0; i < 5; i++) {
      rerender({ loadManifest: ((ref, signal) => spy(ref, signal)) as LoadManifest });
    }

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // The loader must not have been called again by the re-renders.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy).toHaveBeenCalledTimes(1);

    // A retry asks for the manifest once more.
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
