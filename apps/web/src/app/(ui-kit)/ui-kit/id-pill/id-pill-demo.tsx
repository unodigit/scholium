"use client";

import { useState } from "react";

import { IdPill, StatusChip } from "../../../../features/ui-kit";

const PAPER_ID = "sch:k3f9-q2xz-7mwd/v2";

/**
 * Live examples for `/ui-kit/id-pill`.
 *
 * Click any pill: the id goes to the clipboard and a "Copied" toast appears at
 * the bottom of the window. This is a client component only so the first
 * example can show the `onCopied` callback; the pill itself needs no wrapper.
 */
export function IdPillDemo() {
  const [lastCopied, setLastCopied] = useState<string | null>(null);

  return (
    <div className="uk-examples">
      <article className="uk-panel uk-row">
        <h3 className="paper-title">Can a Meta-Agent Choose the Safer Branch?</h3>
        <p className="meta">
          M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago
        </p>
        <div className="uk-chips">
          <StatusChip status="under_review" count={3} />
          <IdPill schId={PAPER_ID} onCopied={setLastCopied} />
        </div>
        <p className="uk-note" aria-live="off">
          {lastCopied === null ? (
            "onCopied has not fired yet."
          ) : (
            <>
              <code>onCopied</code> fired with <code>{lastCopied}</code>.
            </>
          )}
        </p>
      </article>

      <article className="uk-panel">
        <h3>In a sentence</h3>
        <p className="uk-note">
          The pill is inline-flex, so it sits on the text baseline of a line of
          prose or a command.
        </p>
        <p>
          Verify offline: <code>scholium verify</code> <IdPill schId={PAPER_ID} />
        </p>
      </article>

      <article className="uk-panel">
        <h3>In a narrow column</h3>
        <p className="uk-note">
          The id wraps rather than pushing the layout wider than its column.
        </p>
        <div style={{ maxInlineSize: "9rem" }}>
          <IdPill schId={PAPER_ID} />
        </div>
      </article>

      <article className="uk-panel" data-theme="dark">
        <h3>Dark theme</h3>
        <p className="uk-note">
          The pill reads the design tokens, and the toast takes the theme of the
          subtree the pill sits in: <code>data-theme=&quot;dark&quot;</code>.
        </p>
        <IdPill schId={PAPER_ID} />
      </article>
    </div>
  );
}
