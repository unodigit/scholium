import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  RECORD_PATH,
  RecordLink,
  fetchRecordJson,
  formatRecordJson,
  recordErrorMessage,
  type RecordLoader,
} from "./record-link";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CID = "bafyreihbppt2cuitohaqvn5j2xz6qk5e4h5f2n7hs3w6m4a5g2t2xw3y4z5a";
const OTHER_CID = "bafyreifopy6hcw6j5m5m5g3xg2xj4bq5g2t2xw3y4z5a6b7c8d9e0f1g2h3i";

const RECORD = {
  v: 1,
  type: "paper.version",
  author: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
  created: "2026-11-14T05:33:00Z",
  prev: null,
  body: { title: "Can a Meta-Agent Choose the Safer Branch?" },
  proofs: [],
  id: CID,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "View record" });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("RecordLink trigger", () => {
  it("is a real button that says 'View record'", () => {
    render(createElement(RecordLink, { cid: CID, loadRecord: vi.fn() }));

    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.classList.contains("sch-record-link")).toBe(true);
  });

  it("takes a different label without changing its behaviour", () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        label: "View this version",
        loadRecord: vi.fn(),
      }),
    );
    expect(
      screen.getByRole("button", { name: "View this version" }),
    ).toBeTruthy();
  });

  it("does not read the record until it is asked to", () => {
    const loadRecord = vi.fn(async () => RECORD);
    render(createElement(RecordLink, { cid: CID, loadRecord }));

    expect(loadRecord).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing when there is no record to point at", () => {
    for (const cid of ["", "   ", undefined, null, 42]) {
      const { container } = render(
        createElement(RecordLink, { cid, loadRecord: vi.fn() } as never),
      );
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("passes className and other button attributes through", () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: vi.fn(),
        className: "ml-2",
        id: "record-link",
        "data-testid": "record-link",
      } as never),
    );
    const button = trigger();
    expect(button.className).toBe("sch-record-link ml-2");
    expect(button.id).toBe("record-link");
    expect(button.dataset.testid).toBe("record-link");
  });
});

describe("RecordLink side sheet", () => {
  it("opens a modal dialog labelled by its heading and described by the cid", async () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: async () => RECORD,
      }),
    );

    fireEvent.click(trigger());

    const sheet = dialog();
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Signed record" })).toBeTruthy();

    const labelledBy = sheet.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe(
      "Signed record",
    );

    const describedBy = sheet.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(CID);

    // The trigger stays in the document and reports the panel it controls.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(sheet.id);
  });

  it("shows the raw record as pretty-printed JSON, exactly as served", async () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: async () => RECORD,
      }),
    );

    fireEvent.click(trigger());

    const code = await waitFor(() => {
      const pre = dialog().querySelector("pre code");
      if (!pre) throw new Error("record JSON has not rendered");
      return pre;
    });

    expect(code.textContent).toBe(JSON.stringify(RECORD, null, 2));
    expect(code.textContent).toContain('"type": "paper.version"');
    expect(code.textContent).toContain(`"id": "${CID}"`);
    expect(code.textContent).toContain("\n  \"author\"");
  });

  it("reads GET /v1/records/{cid} by default, with no loader injected", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(RECORD));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.scholium.test");

    render(createElement(RecordLink, { cid: CID }));
    fireEvent.click(trigger());

    await waitFor(() =>
      expect(dialog().querySelector("pre code")?.textContent).toContain(
        "paper.version",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://api.scholium.test/v1/records/${CID}`,
    );
  });

  it("shows 'Raw signed JSON' so the sheet says what it is", async () => {
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );
    fireEvent.click(trigger());
    expect(screen.getByText("Raw signed JSON")).toBeTruthy();
    await waitFor(() => expect(dialog().querySelector("pre")).not.toBeNull());
  });

  it("shows a loading state until the record arrives", async () => {
    let resolve!: (value: unknown) => void;
    const loadRecord = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );

    render(createElement(RecordLink, { cid: CID, loadRecord }));
    fireEvent.click(trigger());

    expect(screen.getByRole("status").textContent).toBe("Loading record…");

    resolve(RECORD);
    await waitFor(() =>
      expect(dialog().querySelector("pre code")?.textContent).toContain(
        "paper.version",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders JSON text as text, never as markup", async () => {
    const dangerous = {
      ...RECORD,
      body: { title: '<script>alert("x")</script>' },
    };
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: async () => dangerous,
      }),
    );
    fireEvent.click(trigger());

    await waitFor(() => expect(dialog().querySelector("pre")).not.toBeNull());
    expect(dialog().querySelector("script")).toBeNull();
    const text = dialog().querySelector("pre code")?.textContent ?? "";
    expect(text).toContain("<script>alert");
    expect(text).toContain("</script>");
    expect(text).toContain('\\"x\\"');
  });

  it("moves focus to Close on open and back to the trigger on close", async () => {
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );

    const button = trigger();
    (button as HTMLButtonElement).focus();
    fireEvent.click(button);

    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    await waitFor(() => expect(dialog().querySelector("pre")).not.toBeNull());
    fireEvent.click(close);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );
    const button = trigger();
    (button as HTMLButtonElement).focus();
    fireEvent.click(button);

    fireEvent.keyDown(dialog(), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a click on the scrim, but not inside the panel", async () => {
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );
    fireEvent.click(trigger());

    const panel = dialog();
    const scrim = panel.parentElement as HTMLElement;

    fireEvent.mouseDown(panel);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.mouseDown(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the sheet", async () => {
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );
    fireEvent.click(trigger());

    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("locks the page behind it and restores the overflow afterwards", () => {
    const original = document.body.style.overflow;
    render(
      createElement(RecordLink, { cid: CID, loadRecord: async () => RECORD }),
    );
    fireEvent.click(trigger());
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe(original);
  });

  it("fetches once per open, with the cid and an abort signal", async () => {
    const loadRecord = vi.fn<RecordLoader>(async () => RECORD);
    render(createElement(RecordLink, { cid: CID, loadRecord }));

    fireEvent.click(trigger());
    await waitFor(() => expect(loadRecord).toHaveBeenCalledTimes(1));
    expect(loadRecord.mock.calls[0][0]).toBe(CID);
    expect(loadRecord.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(trigger());
    await waitFor(() => expect(loadRecord).toHaveBeenCalledTimes(2));
  });

  it("aborts the read when the sheet closes", () => {
    const loadRecord = vi.fn(
      (_cid: string, _options?: { signal?: AbortSignal }) =>
        new Promise<unknown>(() => {}),
    );
    render(createElement(RecordLink, { cid: CID, loadRecord }));

    fireEvent.click(trigger());
    const signal = loadRecord.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(signal?.aborted).toBe(true);
  });

  it("reads the new record when the cid changes while open", async () => {
    const loadRecord = vi.fn(async (cid: string) => ({ ...RECORD, id: cid }));
    const { rerender } = render(
      createElement(RecordLink, { cid: CID, loadRecord }),
    );
    fireEvent.click(trigger());
    await waitFor(() =>
      expect(dialog().querySelector("pre code")?.textContent).toContain(CID),
    );

    rerender(createElement(RecordLink, { cid: OTHER_CID, loadRecord }));
    await waitFor(() =>
      expect(dialog().querySelector("pre code")?.textContent).toContain(OTHER_CID),
    );
    expect(loadRecord).toHaveBeenLastCalledWith(OTHER_CID, expect.anything());
  });

  it("reports open and close through onOpenChange", async () => {
    const onOpenChange = vi.fn();
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: async () => RECORD,
        onOpenChange,
      }),
    );

    fireEvent.click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("uses a custom title for the sheet heading", () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        title: "Version record",
        loadRecord: async () => RECORD,
      }),
    );
    fireEvent.click(trigger());
    expect(screen.getByRole("heading", { name: "Version record" })).toBeTruthy();
  });
});

describe("RecordLink failures", () => {
  it("says a missing record is not on this server, in one sentence", async () => {
    const loadRecord = vi.fn(async () => {
      throw new ApiError(404, { status: 404 });
    });
    render(createElement(RecordLink, { cid: CID, loadRecord }));

    fireEvent.click(trigger());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This record is not on this server.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries on 'Try again' and then shows the record", async () => {
    const loadRecord = vi
      .fn<RecordLoader>()
      .mockRejectedValueOnce(new ApiError(500, { status: 500 }))
      .mockResolvedValueOnce(RECORD);

    render(createElement(RecordLink, { cid: CID, loadRecord }));
    fireEvent.click(trigger());

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(dialog().querySelector("pre code")?.textContent).toContain(
        "paper.version",
      ),
    );
    expect(loadRecord).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an empty body rather than showing nothing", async () => {
    render(
      createElement(RecordLink, {
        cid: CID,
        loadRecord: async () => undefined,
      }),
    );
    fireEvent.click(trigger());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The server returned an empty record.",
    );
  });
});

describe("fetchRecordJson", () => {
  it("reads GET /v1/records/{cid} without a bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(RECORD));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.scholium.test");

    await expect(fetchRecordJson(CID)).resolves.toEqual(RECORD);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://api.scholium.test/v1${RECORD_PATH}/${CID}`,
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("URL-encodes the cid instead of assuming base32", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(RECORD));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.scholium.test");

    await fetchRecordJson("a/b?c");

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.scholium.test/v1/records/a%2Fb%3Fc",
    );
  });

  it("passes the abort signal through to the request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(RECORD));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchRecordJson(CID, { signal: controller.signal });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("turns a 404 into an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: 404, title: "Not Found" }, 404)),
    );

    await expect(fetchRecordJson(CID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("recordErrorMessage", () => {
  it("uses one plain sentence per failure", () => {
    expect(recordErrorMessage(new ApiError(404, { status: 404 }))).toBe(
      "This record is not on this server.",
    );
    expect(recordErrorMessage(new ApiError(500, { status: 500 }))).toBe(
      "This record could not be loaded. Try again.",
    );
    expect(
      recordErrorMessage(new NetworkError("https://api.scholium.test")),
    ).toBe("The server could not be reached. Try again.");
    expect(recordErrorMessage(new Error("boom"))).toBe(
      "This record could not be loaded. Try again.",
    );
  });

  it("never leaks problem-details jargon into the UI", () => {
    const message = recordErrorMessage(
      new ApiError(404, {
        status: 404,
        detail:
          "No record with id 'bafy...' is in this node's event log.",
      }),
    );
    expect(message).not.toMatch(/node|event log|bafy/i);
  });
});

describe("formatRecordJson", () => {
  it("pretty-prints with two spaces", () => {
    expect(formatRecordJson({ a: 1, b: [2] })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });

  it("returns an empty string for a value JSON cannot carry", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatRecordJson(cyclic)).toBe("");
    expect(formatRecordJson(undefined)).toBe("");
  });
});
