/**
 * The paper page's way into the New version form (feature 163).
 *
 * A plain link, server-safe (no hooks), so the server-rendered paper page can
 * offer the action before any JavaScript loads:
 *
 * ```tsx
 * import { NewVersionLink } from "../submit";
 *
 * <NewVersionLink paper={paper.shortId} />   // "Submit a new version"
 * ```
 *
 * The form itself (`/submit/new-version/[ref]`) pre-fills from the paper's
 * latest version and signs the next one.
 */

import Link from "next/link";
import type { ReactElement } from "react";

import { newVersionHref } from "./new-version";
import "./submit.css";

export interface NewVersionLinkProps {
  /** The paper's id as the paper page holds it: its `sch:` short id. */
  paper: string;
  /** Override the label, e.g. to name the action on a narrow layout. */
  label?: string;
}

export function NewVersionLink({ paper, label = "Submit a new version" }: NewVersionLinkProps): ReactElement {
  return (
    <Link className="sw-button sw-button--quiet nv-link" href={newVersionHref(paper)}>
      {label}
    </Link>
  );
}
