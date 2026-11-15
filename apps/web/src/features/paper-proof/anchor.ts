/**
 * What the node says about a record's public timestamp.
 *
 * `GET /v1/records/{cid}/proof` (apps/api ledger/proof.py) answers
 * `{ seq, entry_hash, prev_hash, head, anchor }`. Today `anchor` is always the
 * string `"pending"`: the node does not anchor its log on-chain yet, and that
 * is a state, not an error (docs/design.md §1, principle 7).
 *
 * The anchored form below is what docs/design.md §5.3 shows ("Timestamp
 * anchored: 2 Mar 2027 04:00 UTC · View transaction"), so the Verified badge is
 * reachable once the node anchors:
 *
 * ```json
 * { "anchor": { "status": "anchored", "anchored_at": "2027-03-02T04:00:00Z",
 *               "chain": 8453, "batch": 18211,
 *               "tx_url": "https://basescan.org/tx/0x…" } }
 * ```
 *
 * The browser does not check the chain: an anchored claim is the node's word
 * for it, and the Proof tab's technical details say so. Anything this module
 * does not recognise is read as pending rather than guessed at, so an
 * unfamiliar answer can never make a paper look more verified than it is.
 *
 * Pure data and functions, no React.
 */

export type AnchorInfo =
  | { readonly status: "pending" }
  | {
      readonly status: "anchored";
      /** ISO 8601 instant the batch was anchored. */
      readonly anchoredAt: string;
      readonly chain: string | null;
      readonly batch: string | null;
      /** An `https:` link to the transaction, or `null`. */
      readonly txUrl: string | null;
    };

/** The ledger's proof for one record, reduced to what the tab shows. */
export interface RecordProofInfo {
  readonly anchor: AnchorInfo;
  /** Position of the record in the node's event log, when reported. */
  readonly seq: number | null;
}

/** What a node that answered nothing useful, or nothing yet, amounts to. */
export const PENDING_PROOF: RecordProofInfo = {
  anchor: { status: "pending" },
  seq: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Only `https:` links are rendered: a node's string is never a `javascript:` URL. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseAnchor(value: unknown): AnchorInfo {
  if (!isRecord(value) || value.status !== "anchored") {
    return { status: "pending" };
  }
  const at = value.anchored_at;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    // "Anchored" with no usable time is not a timestamp.
    return { status: "pending" };
  }
  return {
    status: "anchored",
    anchoredAt: at,
    chain: label(value.chain),
    batch: label(value.batch),
    txUrl: httpsUrl(value.tx_url),
  };
}

/** Read the body of `GET /v1/records/{cid}/proof`. Never throws. */
export function parseRecordProof(body: unknown): RecordProofInfo {
  if (!isRecord(body)) return PENDING_PROOF;
  const seq = body.seq;
  return {
    anchor: parseAnchor(body.anchor),
    seq: typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null,
  };
}

/** `2 Mar 2027 04:00 UTC`, the same wording in every locale and time zone. */
export function formatAnchorTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${day} ${time} UTC`;
}
