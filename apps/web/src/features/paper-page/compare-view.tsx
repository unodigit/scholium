/**
 * The compare view (feature 186): the paragraph diff between two versions.
 *
 * The Versions tab links here with "Compare v1 with v2". The page names the
 * two versions, says what the authors said changed in each, and then lists the
 * diff the node computed:
 *
 * ```text
 * Changed paragraphs (2)
 *   Changed paragraph
 *   In v1   ~~The baseline was tuned on the test split.~~
 *   In v2   The baseline was tuned on a held-out split.
 * Added in v2
 *   + New paragraph…
 * Removed from v1
 *   − Old paragraph…
 * ```
 *
 * It is a reading surface, not a code diff: paragraphs are set in the reading
 * serif at the reading size, in one column, so long prose stays readable. The
 * old and new sides are stacked, not squeezed side by side.
 *
 * **A difference is never colour alone.** Each section and each row says in
 * words what it is ("Changed paragraph", "Added in v2", "Removed from v1"); the
 * old text is a real `<del>`, the new text a real `<ins>`, and the tint and
 * border reinforce those words. Added paragraphs take `--verified-soft`, removed
 * ones `--critical-soft`, with `--ink` text on both, so the contrast rule holds.
 *
 * Server-safe: the whole view is static markup, so a shared link to a
 * comparison reads before JavaScript runs.
 */

import { changeNoteText } from "../paper-meta/meta";
import type { CompareChange, CompareData, CompareParagraph } from "./compare";
import { describeCompareSummary } from "./compare";
import { versionPagePath } from "./paper-links";
import "./paper-page.css";

export interface CompareViewProps {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  readonly data: CompareData;
  /** The paper's title, when it could be read; the comparison works without it. */
  readonly paperTitle: string | null;
}

export function CompareView({ shortId, data, paperTitle }: CompareViewProps) {
  const fromHref = versionPagePath(shortId, data.from);
  const toHref = versionPagePath(shortId, data.to);
  const empty =
    data.added.length === 0 && data.removed.length === 0 && data.changed.length === 0;

  return (
    <article className="ppg-compare" aria-labelledby="ppg-compare-heading">
      <header className="ppg-compare-header">
        <p className="ppg-compare-back">
          <a href={toHref}>
            <span aria-hidden="true">← </span>
            {`Back to v${data.to}`}
          </a>
        </p>
        <h1 id="ppg-compare-heading" className="ppg-compare-title">
          {`Compare v${data.from} with v${data.to}`}
        </h1>
        {paperTitle !== null ? (
          <p className="ppg-compare-paper">
            <a href={toHref}>{paperTitle}</a>
          </p>
        ) : null}
        <p className="ppg-compare-summary">{describeCompareSummary(data)}</p>
      </header>

      <section className="ppg-compare-notes" aria-labelledby="ppg-compare-notes-heading">
        <h2 id="ppg-compare-notes-heading" className="ppg-section-title">
          Change notes
        </h2>
        <dl className="ppg-compare-note-list">
          <div className="ppg-compare-note">
            <dt>{`Version ${data.from}`}</dt>
            <dd>
              {changeNoteText({ n: data.from, changeNote: data.fromChangeNote })}
            </dd>
          </div>
          <div className="ppg-compare-note">
            <dt>{`Version ${data.to}`}</dt>
            <dd>{changeNoteText({ n: data.to, changeNote: data.toChangeNote })}</dd>
          </div>
        </dl>
      </section>

      {empty ? (
        <p className="ppg-compare-empty" data-testid="ppg-compare-empty">
          Nothing changed between these versions.
        </p>
      ) : null}

      {data.changed.length > 0 ? (
        <section
          className="ppg-compare-section"
          aria-labelledby="ppg-compare-changed-heading"
        >
          <h2 id="ppg-compare-changed-heading" className="ppg-section-title">
            Changed paragraphs{" "}
            <span className="ppg-compare-count">({data.changed.length})</span>
          </h2>
          <ol className="ppg-compare-list">
            {data.changed.map((change, index) => (
              <ChangedRow
                key={`${change.from.id}-${change.to.id}-${index}`}
                change={change}
                from={data.from}
                to={data.to}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {data.added.length > 0 ? (
        <section
          className="ppg-compare-section"
          aria-labelledby="ppg-compare-added-heading"
        >
          <h2 id="ppg-compare-added-heading" className="ppg-section-title">
            {`Added in v${data.to}`}{" "}
            <span className="ppg-compare-count">({data.added.length})</span>
          </h2>
          <ol className="ppg-compare-list">
            {data.added.map((paragraph, index) => (
              <AddedRow
                key={`${paragraph.id}-${index}`}
                paragraph={paragraph}
                to={data.to}
              />
            ))}
          </ol>
        </section>
      ) : null}

      {data.removed.length > 0 ? (
        <section
          className="ppg-compare-section"
          aria-labelledby="ppg-compare-removed-heading"
        >
          <h2 id="ppg-compare-removed-heading" className="ppg-section-title">
            {`Removed from v${data.from}`}{" "}
            <span className="ppg-compare-count">({data.removed.length})</span>
          </h2>
          <ol className="ppg-compare-list">
            {data.removed.map((paragraph, index) => (
              <RemovedRow
                key={`${paragraph.id}-${index}`}
                paragraph={paragraph}
                from={data.from}
              />
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="ppg-compare-footer">
        <a href={fromHref}>{`Read v${data.from}`}</a>
        <a href={toHref}>{`Read v${data.to}`}</a>
      </footer>
    </article>
  );
}

interface ChangedRowProps {
  readonly change: CompareChange;
  readonly from: number;
  readonly to: number;
}

function ChangedRow({ change, from, to }: ChangedRowProps) {
  return (
    <li className="ppg-compare-item" data-kind="changed">
      <p className="ppg-compare-item-label">Changed paragraph</p>
      <div className="ppg-compare-side" data-side="from">
        <p className="ppg-compare-side-label">{`In v${from}`}</p>
        <p className="ppg-compare-text">
          <del>{change.from.text}</del>
        </p>
      </div>
      <div className="ppg-compare-side" data-side="to">
        <p className="ppg-compare-side-label">{`In v${to}`}</p>
        <p className="ppg-compare-text">
          <ins>{change.to.text}</ins>
        </p>
      </div>
    </li>
  );
}

interface AddedRowProps {
  readonly paragraph: CompareParagraph;
  readonly to: number;
}

function AddedRow({ paragraph, to }: AddedRowProps) {
  return (
    <li className="ppg-compare-item" data-kind="added">
      <p className="ppg-compare-item-label">{`Added in v${to}`}</p>
      <p className="ppg-compare-text">
        <ins>{paragraph.text}</ins>
      </p>
    </li>
  );
}

interface RemovedRowProps {
  readonly paragraph: CompareParagraph;
  readonly from: number;
}

function RemovedRow({ paragraph, from }: RemovedRowProps) {
  return (
    <li className="ppg-compare-item" data-kind="removed">
      <p className="ppg-compare-item-label">{`Removed from v${from}`}</p>
      <p className="ppg-compare-text">
        <del>{paragraph.text}</del>
      </p>
    </li>
  );
}

export interface CompareNoticeProps {
  /** One sentence saying why there is no comparison to show. */
  readonly message: string;
  /** Where the reader can go instead. */
  readonly backHref: string;
  /** The words on the way out; "Back to the paper" by default. */
  readonly backLabel?: string;
}

/**
 * The page when there is no comparison to show: a bad address, a version this
 * node does not hold, a node that cannot be reached. One honest message and a
 * way back, like the paper page's own notice.
 */
export function CompareNotice({
  message,
  backHref,
  backLabel = "Back to the paper",
}: CompareNoticeProps) {
  return (
    <section className="ppg-notice" role="alert">
      <h1 className="ppg-notice-title">Comparison unavailable</h1>
      <p className="ppg-notice-message">{message}</p>
      <a className="ppg-notice-link" href={backHref}>
        {backLabel}
      </a>
    </section>
  );
}
