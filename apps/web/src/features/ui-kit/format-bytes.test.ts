import { describe, expect, it } from "vitest";

import { formatBytes } from "./format-bytes";

/**
 * One size format for the whole product (bug_spec_verify5 bug 5): the Files
 * tab, the compare view and `/verify` all print `759 B`, `3.0 KB`, `1.5 MB`
 * with the same function. Before this, the three pages used three spellings —
 * `759 B`, `759 bytes` and `735 bytes` — so the same file looked different
 * depending on where a reader met it.
 */
describe("formatBytes", () => {
  it("uses B, KB and MB with one decimal for anything above 1024 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(759)).toBe("759 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024)).toBe("3.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });

  it("says something honest for a size it cannot read", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});
