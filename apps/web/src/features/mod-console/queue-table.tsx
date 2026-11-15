/**
 * The moderation queue table: paper, category, age and the four automated
 * signals (docs/design.md §5.7).
 *
 * One row per version waiting for a decision, in the order given (the loader
 * sorts oldest first). Every signal is an icon plus a word — never colour
 * alone (design.md §9) — so a moderator scanning the column can tell a clean
 * scan from a failed one without relying on hue.
 *
 * Server-safe (no hooks, no state): it renders whatever entries it is handed.
 */

import { Icon } from "../ui-kit/icons";
import {
  accountSignal,
  formatAge,
  formatCategories,
  modDetailHref,
  referencesSignal,
  scanSignal,
  similaritySignal,
  type QueueEntry,
  type Signal,
} from "./queue";
import "./mod-console.css";

/** A signal as it appears in a cell: optional icon, then the words. */
function SignalCell({ signal }: { signal: Signal }) {
  return (
    <span className={`mc-signal mc-signal--${signal.tone}`}>
      {signal.icon ? (
        <Icon name={signal.icon} className="mc-signal-icon" />
      ) : null}
      <span className="mc-signal-text">{signal.text}</span>
    </span>
  );
}

/** One version: its paper, category, age and signals. */
function QueueRow({ entry }: { entry: QueueEntry }) {
  return (
    <tr className="mc-row">
      <th scope="row" className="mc-cell mc-cell-paper">
        {/* The title opens the decision view for this version. */}
        <a
          className="mc-paper-title mc-paper-link"
          href={modDetailHref(entry.versionCid)}
        >
          {entry.title}
        </a>
        {entry.shortId ? (
          <span className="mc-paper-id mono-id">{entry.shortId}</span>
        ) : null}
      </th>
      <td className="mc-cell">{formatCategories(entry.categories)}</td>
      <td className="mc-cell mc-cell-num">{formatAge(entry.ageHours)}</td>
      <td className="mc-cell mc-cell-num">
        <SignalCell signal={similaritySignal(entry.similarityPct)} />
      </td>
      <td className="mc-cell">
        <SignalCell signal={referencesSignal(entry.referencesUnresolved)} />
      </td>
      <td className="mc-cell">
        <SignalCell signal={scanSignal(entry.scan)} />
      </td>
      <td className="mc-cell">
        <SignalCell signal={accountSignal(entry.newAccount)} />
      </td>
    </tr>
  );
}

/** Props for {@link QueueTable}. */
export interface QueueTableProps {
  entries: readonly QueueEntry[];
}

/**
 * The queue as a table.
 *
 * The table is wider than a phone, so it scrolls inside a focusable region:
 * a keyboard user can reach it and scroll it without a pointer, and the page
 * itself never scrolls sideways.
 */
export function QueueTable({ entries }: QueueTableProps) {
  return (
    <div
      className="mc-table-wrap"
      role="region"
      aria-label="Moderation queue"
      tabIndex={0}
    >
      <table className="mc-table">
        <caption className="mc-sr-only">
          Versions waiting for a moderation decision, oldest first
        </caption>
        <thead>
          <tr>
            <th scope="col" className="mc-head">
              Paper
            </th>
            <th scope="col" className="mc-head">
              Category
            </th>
            <th scope="col" className="mc-head mc-head-num">
              Age
            </th>
            <th scope="col" className="mc-head mc-head-num">
              Similarity
            </th>
            <th scope="col" className="mc-head">
              Unresolved references
            </th>
            <th scope="col" className="mc-head">
              Scan
            </th>
            <th scope="col" className="mc-head">
              Account
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <QueueRow key={entry.versionCid} entry={entry} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default QueueTable;
