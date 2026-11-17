/**
 * The site footer — `docs/design.md` §4 (the sitemap's Network, Policies and
 * Verify a file), PRD NET-2 (the public export).
 *
 * The root layout renders it once, under every page's content, so these four
 * destinations are one click from anywhere — including pages that carry no
 * navigation of their own (sign-in, not-found, error):
 *
 * - Network (`/network`) — the node's public transparency page,
 * - Verify a file (`/verify`) — check a file against what its authors signed,
 * - Policies (`/policies`) — the rules the node moderates by,
 * - Public export — the whole public archive as one CAR file the API serves at
 *   `GET /v1/export/archive.car`, so anyone can rebuild the archive themselves.
 *
 * It is a server component with no state: the glyph, a one-line description of
 * the site and a labelled list of links. On phones it also pads its bottom edge
 * by the height of the fixed tab bar (`components/nav`), so its last line is
 * never hidden behind it. Styles are in `footer.css`.
 */

import Link from "next/link";

import { BrandMark } from "../../features/ui-kit/brand-mark";
import { resolveApiBaseUrl } from "../../lib/api";
import "./footer.css";

/** Where the API serves the whole public archive (PRD NET-2). */
export const PUBLIC_EXPORT_PATH = "/v1/export/archive.car";

/**
 * The one-line description of the site: the same words as the page
 * description in `app/site-metadata.ts` and the sign-in tagline, and free of
 * the word "node", which design.md §8 keeps out of primary UI.
 */
export const SITE_FOOTER_DESCRIPTION = "Signed, open preprints and peer review";

/** Ties the "CAR archive" note to the export link as its description. */
const EXPORT_NOTE_ID = "site-footer-export-note";

/**
 * The public export's address. It is an absolute URL on the API origin
 * (`NEXT_PUBLIC_API_URL`) because the browser follows it as a plain link, the
 * way the paper page's archive link does; the response is sent as an
 * attachment, so following it downloads the file.
 */
export function publicExportHref(baseUrl?: string): string {
  return `${resolveApiBaseUrl(baseUrl)}${PUBLIC_EXPORT_PATH}`;
}

/** The footer under every page. */
export function SiteFooter() {
  return (
    <footer className="sf">
      <div className="sf-about">
        <BrandMark variant="glyph" size="sm" decorative className="sf-mark" />
        <p className="sf-description">{SITE_FOOTER_DESCRIPTION}</p>
      </div>

      <nav className="sf-nav" aria-label="Footer">
        <ul className="sf-links">
          <li>
            <Link className="sf-link" href="/network">
              Network
            </Link>
          </li>
          <li>
            <Link className="sf-link" href="/verify">
              Verify a file
            </Link>
          </li>
          <li>
            <Link className="sf-link" href="/policies">
              Policies
            </Link>
          </li>
          <li className="sf-export">
            <a
              className="sf-link"
              href={publicExportHref()}
              aria-describedby={EXPORT_NOTE_ID}
            >
              Public export
            </a>
            <span className="sf-note" id={EXPORT_NOTE_ID}>
              CAR archive
            </span>
          </li>
        </ul>
      </nav>
    </footer>
  );
}
