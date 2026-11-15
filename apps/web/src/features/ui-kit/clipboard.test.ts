import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

/** jsdom has neither `navigator.clipboard` nor `document.execCommand`. */
function stubClipboardApi(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function stubExecCommand(impl: (command: string) => boolean): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

describe("copyText with the Clipboard API", () => {
  it("writes the text and resolves true", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);

    await expect(copyText("sch:k3f9-q2xz-7mwd/v3")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("sch:k3f9-q2xz-7mwd/v3");
  });

  it("calls the API synchronously, so the click's user activation is still live", () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboardApi(writeText);

    void copyText("sch:k3f9-q2xz-7mwd");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("does not touch the legacy route when the API succeeds", async () => {
    stubClipboardApi(async () => undefined);
    const execCommand = stubExecCommand(() => true);

    await copyText("sch:k3f9-q2xz-7mwd");
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("copyText falling back to execCommand", () => {
  it("falls back when the API rejects, and copies the exact text", async () => {
    stubClipboardApi(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    let selected = "";
    const execCommand = stubExecCommand((command) => {
      const area = document.querySelector("textarea");
      selected = area ? area.value.slice(area.selectionStart, area.selectionEnd) : "";
      return command === "copy";
    });

    await expect(copyText("sch:k3f9-q2xz-7mwd/v3")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(selected).toBe("sch:k3f9-q2xz-7mwd/v3");
  });

  it("falls back when there is no Clipboard API (a plain-HTTP node)", async () => {
    const execCommand = stubExecCommand(() => true);

    await expect(copyText("sch:k3f9-q2xz-7mwd")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  it("leaves no textarea behind", async () => {
    stubExecCommand(() => true);
    await copyText("sch:k3f9-q2xz-7mwd");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("puts focus back where it was", async () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    stubExecCommand(() => true);

    await copyText("sch:k3f9-q2xz-7mwd");
    expect(document.activeElement).toBe(button);
  });

  it("resolves false when the browser says the copy did not happen", async () => {
    stubExecCommand(() => false);
    await expect(copyText("sch:k3f9-q2xz-7mwd")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("resolves false, not a rejection, when execCommand throws", async () => {
    stubExecCommand(() => {
      throw new Error("not allowed");
    });
    await expect(copyText("sch:k3f9-q2xz-7mwd")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("copyText with no way to copy", () => {
  it("resolves false when neither route exists", async () => {
    await expect(copyText("sch:k3f9-q2xz-7mwd")).resolves.toBe(false);
  });

  it("resolves false when the API rejects and there is no legacy route", async () => {
    stubClipboardApi(async () => {
      throw new Error("denied");
    });
    await expect(copyText("sch:k3f9-q2xz-7mwd")).resolves.toBe(false);
  });
});
