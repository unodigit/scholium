/**
 * What each file in a submission is *for*, and which drop zone it came from.
 *
 * The Files step has two drop zones. "Paper" takes the PDF and/or the LaTeX
 * source; "Code and data" takes everything else the author wants to publish
 * alongside it. The zone sets a file's default role from its extension, and the
 * author can correct it from the row's role menu.
 *
 * The role is a client-side label for the manifest the later steps build. It is
 * also sent in the tus `Upload-Metadata` as `role`, which the API stores but
 * does not interpret.
 */

import { isPdf } from "./limits";

export const FILE_ROLES = ["pdf", "source", "code", "data"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export const ROLE_LABELS: Record<FileRole, string> = {
  pdf: "Paper PDF",
  source: "LaTeX source",
  code: "Code",
  data: "Data",
};

export type FileZone = "paper" | "extras";

/** Roles that make a submission complete enough to continue: the paper itself. */
export const PAPER_ROLES: readonly FileRole[] = ["pdf", "source"];

/** Extensions of LaTeX project files and the figures they usually ship with. */
const LATEX_EXTENSIONS = new Set([
  "tex", "latex", "ltx", "bib", "bbl", "bst", "sty", "cls", "clo", "def", "cfg", "dtx", "ins",
  "png", "jpg", "jpeg", "svg", "eps",
]);

/** Archives: a LaTeX project, or a bundle of code or data, in one file. */
const ARCHIVE_SUFFIXES = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".7z", ".gz", ".xz", ".zst"];

/** Extensions that mean "this is code" when dropped in the code-and-data zone. */
const CODE_EXTENSIONS = new Set([
  "py", "ipynb", "r", "rmd", "jl", "m", "js", "mjs", "ts", "tsx", "jsx", "c", "h", "cc", "cpp", "hpp",
  "cu", "rs", "go", "java", "kt", "scala", "swift", "rb", "pl", "lua", "sh", "bash", "sql", "ml", "hs",
  "f90", "f", "cmake", "mk", "toml", "yml", "yaml", "dockerfile",
]);

/** The lower-cased extension after the last dot, or `""` when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** True for a `.zip`, `.tar.gz`, … name. */
export function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True for a file the "Paper" zone accepts: a PDF, LaTeX project file, figure or archive. */
export function isPaperFile(file: { name: string; type: string }): boolean {
  return isPdf(file) || isArchive(file.name) || LATEX_EXTENSIONS.has(extensionOf(file.name));
}

/**
 * The role a file gets by default in `zone`, or `null` when the zone does not
 * take it.
 *
 * - Paper zone: a PDF is the paper PDF; LaTeX files, figures and archives are
 *   the LaTeX source; anything else is not accepted there.
 * - Code-and-data zone: everything is accepted; recognised code is code, the
 *   rest (including a supplementary PDF) is data.
 */
export function defaultRole(file: { name: string; type: string }, zone: FileZone): FileRole | null {
  if (zone === "paper") {
    if (isPdf(file)) {
      return "pdf";
    }
    return isPaperFile(file) ? "source" : null;
  }
  return CODE_EXTENSIONS.has(extensionOf(file.name)) ? "code" : "data";
}

/** The roles a file may be switched to: only a real PDF can be the paper PDF. */
export function rolesFor(file: { name: string; type: string }): FileRole[] {
  return isPdf(file) ? [...FILE_ROLES] : FILE_ROLES.filter((role) => role !== "pdf");
}

/** The message for a file the zone does not take. */
export function unsupportedMessage(zone: FileZone): string {
  return zone === "paper"
    ? "Only a PDF or LaTeX source (.tex files, figures or a .zip/.tar.gz of them) can go here. " +
        "Add anything else under Code and data."
    : "This file type is not accepted.";
}
