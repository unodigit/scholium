/**
 * Size limits for the submit wizard's Files step, and the helpers that state
 * them.
 *
 * The numbers mirror the API's `uploads` module (`limits.py`), which is the
 * authority: a PDF may be at most 50 MiB and anything else at most 5 GiB, and
 * the server decides "PDF" from the declared file name or media type. Checking
 * the same rule here only saves a doomed upload; the server still enforces it.
 *
 * Sizes are shown in binary multiples under the familiar "MB"/"GB" labels (the
 * way Windows and the API's own messages do), so the figure on screen is the
 * figure the limit is measured in.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

/** Largest PDF the API accepts: 50 MiB. */
export const PDF_MAX_BYTES = 50 * MIB;

/** Largest file of any other kind (LaTeX source, code, data) the API accepts: 5 GiB. */
export const FILE_MAX_BYTES = 5 * GIB;

/** The limits as stated on the page, in the order they are shown. */
export const SIZE_LIMITS = [
  { id: "pdf", label: "PDF", limit: "50 MB" },
  { id: "other", label: "LaTeX source, code and data", limit: "5 GB per file" },
] as const;

/** The minimum a file needs to be judged: what the browser knows about it. */
export interface FileFacts {
  name: string;
  type: string;
  size: number;
}

/**
 * Whether the API will treat this file as a PDF.
 *
 * Same signals as the server: a `.pdf` name or a media type that mentions
 * "pdf". Either one is enough, because the PDF limit is the stricter one and a
 * file must not slip past it by also looking like something else.
 */
export function isPdf(file: Pick<FileFacts, "name" | "type">): boolean {
  return file.name.toLowerCase().endsWith(".pdf") || file.type.toLowerCase().includes("pdf");
}

/** The most bytes the API accepts for this file. */
export function maxBytesFor(file: Pick<FileFacts, "name" | "type">): number {
  return isPdf(file) ? PDF_MAX_BYTES : FILE_MAX_BYTES;
}

/** "523 KB", "49.6 MB", "1.2 GB": binary multiples, short enough for a table cell. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < KIB) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < MIB) {
    const kib = bytes / KIB;
    return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
  }
  if (bytes < GIB) {
    return `${(bytes / MIB).toFixed(1)} MB`;
  }
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** `52428800` → "52,428,800 bytes": the exact figure, for messages near a limit. */
export function formatExactBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/**
 * A count with its noun, agreeing in number: `pluralize(1, "file")` is
 * "1 file", `pluralize(2, "file")` is "2 files". A noun with an irregular plural
 * names it: `pluralize(2, "category", "categories")`. Zero takes the plural, as
 * in "0 files".
 */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/** Why a file cannot be uploaded on size grounds alone. */
export interface SizeProblem {
  code: "empty" | "too-large";
  message: string;
}

/** `null` when the file's size is acceptable, otherwise the reason it is not. */
export function checkSize(file: FileFacts): SizeProblem | null {
  if (file.size <= 0) {
    return { code: "empty", message: "This file is empty." };
  }
  const limit = maxBytesFor(file);
  if (file.size > limit) {
    const kind = isPdf(file) ? "PDFs" : "Files";
    return {
      code: "too-large",
      message:
        `This file is ${formatBytes(file.size)} (${formatExactBytes(file.size)}). ` +
        `${kind} can be at most ${formatBytes(limit)} (${formatExactBytes(limit)}).`,
    };
  }
  return null;
}
