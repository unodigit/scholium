/**
 * Small inline icons for the submit wizard. Stroke-only, `currentColor`, and
 * `aria-hidden`: every icon here sits next to a word that carries the meaning,
 * so none of them is ever the only signal (docs/design.md §9).
 */

import type { ReactElement } from "react";

import type { ConsentStatus } from "./consents";
import type { EntryStatus } from "./upload-manager";

function Svg({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className="sw-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function CheckIcon(): ReactElement {
  return (
    <Svg>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </Svg>
  );
}

/** A circled "i": something worth checking, not a failure. */
export function InfoIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2v4" />
      <path d="M8 4.9v.1" />
    </Svg>
  );
}

export function UploadFileIcon(): ReactElement {
  return (
    <svg
      className="sw-icon sw-icon--large"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3.5h8l5 5V22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z" />
      <path d="M16 3.5v5h5" />
      <path d="M14 20v-7M11 15.5l3-3 3 3" />
    </svg>
  );
}

/** One distinct silhouette per status, so the chip reads without colour. */
export function StatusIcon({ status }: { status: EntryStatus }): ReactElement {
  switch (status) {
    case "complete":
      return <CheckIcon />;
    case "uploading":
      return (
        <Svg>
          <path d="M8 13V3.5M4.5 7L8 3.5 11.5 7" />
        </Svg>
      );
    case "reconnecting":
      return (
        <Svg>
          <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" />
        </Svg>
      );
    case "verifying":
      return (
        <Svg>
          <circle cx="7" cy="7" r="4" />
          <path d="M10 10l3.5 3.5" />
        </Svg>
      );
    case "paused":
      return (
        <Svg>
          <path d="M6 3.5v9M10 3.5v9" />
        </Svg>
      );
    case "failed":
      return (
        <Svg>
          <path d="M4 4l8 8M12 4l-8 8" />
        </Svg>
      );
    case "rejected":
      return (
        <Svg>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M4.2 11.8l7.6-7.6" />
        </Svg>
      );
    case "queued":
    default:
      return (
        <Svg>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 4.8V8l2.2 1.4" />
        </Svg>
      );
  }
}

/** Waiting for a co-author: a clock face, like a queued file. */
export function ClockIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.4" />
    </Svg>
  );
}

export function CrossIcon(): ReactElement {
  return (
    <Svg>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

/** One silhouette per consent status, so the chip reads without colour. */
export function ConsentIcon({ status }: { status: ConsentStatus }): ReactElement {
  switch (status) {
    case "signed":
      return <CheckIcon />;
    case "declined":
      return <CrossIcon />;
    case "waiting":
    default:
      return <ClockIcon />;
  }
}

/** A warning triangle: something the author should fix, not a crash. */
export function WarningIcon(): ReactElement {
  return (
    <Svg>
      <path d="M8 2.8L14 13H2L8 2.8z" />
      <path d="M8 6.4v3.1" />
      <path d="M8 11.4v.1" />
    </Svg>
  );
}

/** A shield with a tick: the file safety scan. */
export function ShieldIcon(): ReactElement {
  return (
    <Svg>
      <path d="M8 2l5 1.8v4.1c0 2.7-2 5-5 6.1-3-1.1-5-3.4-5-6.1V3.8L8 2z" />
      <path d="M5.8 8l1.6 1.6L10.4 6.5" />
    </Svg>
  );
}

/** A page with a chain link: the reference check. */
export function ReferenceIcon(): ReactElement {
  return (
    <Svg>
      <path d="M4.5 2.5h5l3 3v8h-8z" />
      <path d="M9.5 2.5v3h3" />
      <path d="M6.4 10.3l1.1-1.1M9.6 8.8l.6-.6a1.4 1.4 0 0 0-1.9-2l-.6.6M7.1 10.2l-.6.6a1.4 1.4 0 0 0 1.9 2l.6-.6" />
    </Svg>
  );
}

/** Two overlapping rings: how much text is shared with another paper. */
export function SimilarityIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="6.2" cy="8" r="3.6" />
      <circle cx="9.8" cy="8" r="3.6" />
    </Svg>
  );
}

/** A tag: the metadata match between the signed title and page one. */
export function TitleIcon(): ReactElement {
  return (
    <Svg>
      <path d="M2.8 2.8h5.1l5.3 5.3-5.1 5.1-5.3-5.3V2.8z" />
      <path d="M5.6 5.6v.1" />
    </Svg>
  );
}

export function ArrowUpIcon(): ReactElement {
  return (
    <Svg>
      <path d="M8 13V3.5M4.5 7L8 3.5 11.5 7" />
    </Svg>
  );
}

export function ArrowDownIcon(): ReactElement {
  return (
    <Svg>
      <path d="M8 3v9.5M4.5 9L8 12.5 11.5 9" />
    </Svg>
  );
}

export function PlusIcon(): ReactElement {
  return (
    <Svg>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

/** A head and shoulders, for an avatar with no letters to show. */
export function PersonIcon(): ReactElement {
  return (
    <Svg>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.5-2.4 2.4-3.8 5-3.8s4.5 1.4 5 3.8" />
    </Svg>
  );
}
