/**
 * Small inline icons for the submit wizard. Stroke-only, `currentColor`, and
 * `aria-hidden`: every icon here sits next to a word that carries the meaning,
 * so none of them is ever the only signal (docs/design.md §9).
 */

import type { ReactElement } from "react";

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
