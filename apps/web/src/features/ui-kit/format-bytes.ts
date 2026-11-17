/**
 * One size format for the whole product.
 *
 * The Files tab, the compare view and `/verify` all show the same signed file,
 * so they must say its size the same way (bug_spec_verify5 bug 5). Before this
 * module each page kept its own spelling — `759 B`, `759 bytes`, `0.7 KiB` —
 * and a reader comparing two pages could not tell that the numbers agreed.
 *
 * `759 B`, `3.0 KB`, `1.5 MB`: binary multiples (1024), the short units a
 * table cell has room for, and one decimal once the unit is larger than bytes.
 * A size that is not a real length reads "—" rather than a made-up number.
 *
 * Pure data and functions, no React.
 */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** `759` → "759 B", `3072` → "3.0 KB", `1572864` → "1.5 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < KIB) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < MIB) {
    return `${(bytes / KIB).toFixed(1)} KB`;
  }
  if (bytes < GIB) {
    return `${(bytes / MIB).toFixed(1)} MB`;
  }
  // Larger than any file the node accepts today, but a page must not print
  // "10240.0 MB" if one ever is.
  return `${(bytes / GIB).toFixed(1)} GB`;
}
