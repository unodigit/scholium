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
 * A new version can change more than its paragraphs, so the page also lists
 * the **files** that were added, removed or replaced (with their sizes) and the
 * **title and abstract** as a word-level text diff; the change notes carry the
 * same diff inline. A part the node could not read is said to be unread — the
 * page never claims "Nothing changed" about something it did not compare.
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

import { changeNoteText, roleLabel } from "../paper-meta/meta";
import type {
  CompareChange,
  CompareData,
  CompareParagraph,
  FileChange,
  TextChange,
  TextSegment,
} from "./compare";
import { describeCompareSummary, describeFileChange, isUnchanged } from "./compare";
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
  const empty = isUnchanged(data);
  const fileChanges = data.files ?? [];
  // The change note's diff is drawn inside the Change notes section below.
  const noteChange = data.details.find((change) => change.field === "changeNote");
  const fieldChanges = data.details.filter((change) => change.field !== "changeNote");

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
              {noteDiffers(noteChange) ? (
                <Segments segments={noteChange.segments} side="from" />
              ) : (
                changeNoteText({ n: data.from, changeNote: data.fromChangeNote })
              )}
            </dd>
          </div>
          <div className="ppg-compare-note">
            <dt>{`Version ${data.to}`}</dt>
            <dd>
              {noteDiffers(noteChange) ? (
                <Segments segments={noteChange.segments} side="to" />
              ) : (
                changeNoteText({ n: data.to, changeNote: data.toChangeNote })
              )}
            </dd>
          </div>
        </dl>
      </section>

      {empty ? (
        <p className="ppg-compare-empty" data-testid="ppg-compare-empty">
          Nothing changed between these versions.
        </p>
      ) : null}

      {data.files === null || !data.detailsRead ? (
        <p className="ppg-compare-empty ppg-compare-unread" role="note" data-testid="ppg-compare-unread">
          {unreadSentence(data)}
        </p>
      ) : null}

      {fileChanges.length > 0 ? (
        <section className="ppg-compare-section" aria-labelledby="ppg-compare-files-heading">
          <h2 id="ppg-compare-files-heading" className="ppg-section-title">
            Files <span className="ppg-compare-count">({fileChanges.length})</span>
          </h2>
          <ol className="ppg-compare-list">
            {fileChanges.map((change) => (
              <FileRow key={`${change.kind}-${change.path}`} change={change} />
            ))}
          </ol>
        </section>
      ) : null}

      {fieldChanges.length > 0 ? (
        <section className="ppg-compare-section" aria-labelledby="ppg-compare-text-heading">
          <h2 id="ppg-compare-text-heading" className="ppg-section-title">
            {fieldChanges.map((change) => change.label).join(" and ")}
          </h2>
          <ol className="ppg-compare-list">
            {fieldChanges.map((change) => (
              <TextRow key={change.field} change={change} from={data.from} to={data.to} />
            ))}
          </ol>
        </section>
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

/** What the page could not compare, in a sentence. */
function unreadSentence(data: CompareData): string {
  const parts: string[] = [];
  if (data.files === null) {
    parts.push("the files");
  }
  if (!data.detailsRead) {
    parts.push("the title and abstract");
  }
  return `${parts.join(" and ").replace(/^./, (letter) => letter.toUpperCase())} of these versions could not be compared, so differences there are not shown.`;
}

/** True when the change note has a text diff to draw (both versions wrote one). */
function noteDiffers(change: TextChange | undefined): change is TextChange {
  return change !== undefined && change.from !== null && change.to !== null;
}

/**
 * One side of a word diff: unchanged words as text, the words that went (or
 * came) in a real `<del>` (or `<ins>`). The other side's words are left out, so
 * each side reads as the text it is.
 */
function Segments({
  segments,
  side,
}: {
  readonly segments: readonly TextSegment[];
  readonly side: "from" | "to";
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "same") {
          return <span key={index}>{segment.text}</span>;
        }
        if (segment.kind === "removed") {
          return side === "from" ? <del key={index}>{segment.text}</del> : null;
        }
        return side === "to" ? <ins key={index}>{segment.text}</ins> : null;
      })}
    </>
  );
}

function TextRow({
  change,
  from,
  to,
}: {
  readonly change: TextChange;
  readonly from: number;
  readonly to: number;
}) {
  return (
    <li className="ppg-compare-item" data-kind="changed" data-field={change.field}>
      <p className="ppg-compare-item-label">{`${change.label} changed`}</p>
      <div className="ppg-compare-side" data-side="from">
        <p className="ppg-compare-side-label">{`In v${from}`}</p>
        <p className="ppg-compare-text">
          <Segments segments={change.segments} side="from" />
        </p>
      </div>
      <div className="ppg-compare-side" data-side="to">
        <p className="ppg-compare-side-label">{`In v${to}`}</p>
        <p className="ppg-compare-text">
          <Segments segments={change.segments} side="to" />
        </p>
      </div>
    </li>
  );
}

/** One file the versions do not share, said in words with its size, never by colour alone. */
function FileRow({ change }: { readonly change: FileChange }) {
  const role = roleLabel((change.to ?? change.from)?.role);
  return (
    <li
      className="ppg-compare-item"
      data-kind={change.kind === "replaced" ? "changed" : change.kind}
      data-file-change={change.kind}
    >
      <p className="ppg-compare-item-label">{describeFileChange(change)}</p>
      <p className="ppg-compare-side-label">{role}</p>
    </li>
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
