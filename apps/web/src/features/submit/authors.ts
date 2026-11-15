/**
 * Step 3 of the submit wizard: Authors (docs/design.md §5.4).
 *
 * "Add co-authors by ORCID or email; assign CRediT roles; order — each
 * co-author gets a consent link."
 *
 * This module is the data and the rules; `authors-step.tsx` is the form. The
 * roster is a plain array of {@link DraftAuthor}, owned by `SubmitWizard` so
 * stepping back and forward keeps it, and every operation here returns a new
 * array.
 *
 * What the signed record can carry decides what Continue waits for. A
 * `paper.version` lists authors by DID (`apps/api/packages/record-core/schemas/
 * paper.version.json`), so an author added by ORCID iD or email is only a
 * *candidate* until something matches them to a DID. This release has no
 * lookup to do that (the API exposes none), so they are shown as "Not matched"
 * and block Continue rather than being dropped from the byline later. A
 * `resolveAuthor` function passed to the step is the one place to plug a
 * lookup in.
 */

/** How a co-author was identified when they were added. */
export type AuthorIdKind = "did" | "orcid" | "email";

/** Whether a DID is known for this author. A lookup in flight is the step's own state, not the draft's. */
export type MatchState = "matched" | "unmatched";

export interface DraftAuthor {
  /** Stable for the life of the draft; never reused after a removal. */
  key: string;
  kind: AuthorIdKind;
  /**
   * The identifier as normalised: the DID, the hyphenated ORCID iD, or the
   * lower-case email. `null` only for the submitter before their DID is known.
   */
  identifier: string | null;
  /** The DID the signed record will list, once known. */
  did: string | null;
  /** How the author is shown in the byline; empty when none was given. */
  name: string;
  /** The ORCID iD, when the author was added by it or a lookup found it. */
  orcid: string | null;
  /** CRediT roles, always in the taxonomy's own order. */
  creditRoles: string[];
  /** The signed-in author who is building the submission. */
  isSubmitter: boolean;
  match: MatchState;
}

// ---------------------------------------------------------------------------
// CRediT
// ---------------------------------------------------------------------------

export interface CreditRole {
  /** The value stored in the record's `creditRoles`, CRediT's own name. */
  id: string;
  /** One line saying what the role covers, read out with the role. */
  summary: string;
}

/**
 * The fourteen roles of the Contributor Roles Taxonomy (CRediT, ANSI/NISO
 * Z39.104-2022), in the taxonomy's alphabetical order. The names are CRediT's
 * own, so a role copied from a journal's form matches.
 */
export const CREDIT_ROLES: readonly CreditRole[] = [
  { id: "Conceptualization", summary: "Ideas; formulation of overarching research goals and aims." },
  { id: "Data curation", summary: "Managing, annotating and keeping research data for reuse." },
  { id: "Formal analysis", summary: "Statistical, mathematical or computational analysis of the data." },
  { id: "Funding acquisition", summary: "Winning the financial support for the project." },
  { id: "Investigation", summary: "Running the experiments or collecting the evidence." },
  { id: "Methodology", summary: "Developing or designing the methods." },
  { id: "Project administration", summary: "Managing and coordinating the research activity." },
  { id: "Resources", summary: "Providing study materials, instruments, computing or other tools." },
  { id: "Software", summary: "Programming, and implementing code and algorithms." },
  { id: "Supervision", summary: "Oversight and leadership of the research team." },
  { id: "Validation", summary: "Verifying that results and outputs replicate." },
  { id: "Visualization", summary: "Preparing figures and other visual presentation of the data." },
  { id: "Writing – original draft", summary: "Writing the first draft of the paper." },
  { id: "Writing – review & editing", summary: "Critical review, commentary or revision of the draft." },
];

const CREDIT_ORDER: ReadonlyMap<string, number> = new Map(CREDIT_ROLES.map((role, index) => [role.id, index]));

export function isCreditRole(id: string): boolean {
  return CREDIT_ORDER.has(id);
}

/** `roles` without repeats or unknown names, in CRediT order. */
export function sortCreditRoles(roles: readonly string[]): string[] {
  return [...new Set(roles)].filter(isCreditRole).sort((a, b) => CREDIT_ORDER.get(a)! - CREDIT_ORDER.get(b)!);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type ParsedIdentifier =
  | { ok: true; kind: AuthorIdKind; value: string }
  | { ok: false; message: string };

export const IDENTIFIER_HELP =
  "Enter a DID (did:key:…), an ORCID iD (0000-0002-1825-0097) or an email address.";

const DID_PATTERN = /^did:[a-z0-9]+:\S+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const ORCID_URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?orcid\.org\//i;
const ORCID_LABEL_PREFIX = /^orcid\s*:?\s*/i;
const ORCID_SHAPE = /^(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])$/;

/** The check character of an ORCID iD's first fifteen digits (ISO 7064 mod 11-2). */
export function orcidCheckCharacter(digits: string): string {
  let total = 0;
  for (const digit of digits) {
    total = (total + Number(digit)) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? "X" : String(result);
}

/** The hyphenated iD (`0000-0002-1825-0097`) for a valid ORCID in any common spelling, else `null`. */
export function normalizeOrcid(input: string): string | null {
  const text = input.trim().replace(ORCID_URL_PREFIX, "").replace(ORCID_LABEL_PREFIX, "");
  const match = ORCID_SHAPE.exec(text);
  if (match === null) {
    return null;
  }
  const digits = `${match[1]}${match[2]}${match[3]}${match[4]}`.toUpperCase();
  if (orcidCheckCharacter(digits.slice(0, 15)) !== digits[15]) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}-${match[4].toUpperCase()}`;
}

/** Tell a DID, an ORCID iD and an email apart, and refuse what is none of them. */
export function parseIdentifier(input: string): ParsedIdentifier {
  const text = input.trim();
  if (text === "") {
    return { ok: false, message: IDENTIFIER_HELP };
  }

  if (/^did:/i.test(text)) {
    return DID_PATTERN.test(text)
      ? { ok: true, kind: "did", value: text }
      : { ok: false, message: "That does not look like a DID. It reads did:method:identifier, with no spaces." };
  }

  if (text.includes("@")) {
    return EMAIL_PATTERN.test(text) && text.length <= EMAIL_MAX_LENGTH
      ? { ok: true, kind: "email", value: text.toLowerCase() }
      : { ok: false, message: "That does not look like an email address." };
  }

  const orcid = normalizeOrcid(text);
  if (orcid !== null) {
    return { ok: true, kind: "orcid", value: orcid };
  }
  const bare = text.replace(ORCID_URL_PREFIX, "").replace(ORCID_LABEL_PREFIX, "");
  if (ORCID_SHAPE.test(bare)) {
    return {
      ok: false,
      message: "That ORCID iD fails its check digit. Look for a mistyped number.",
    };
  }
  return { ok: false, message: IDENTIFIER_HELP };
}

export const KIND_LABELS: Record<AuthorIdKind, string> = {
  did: "DID",
  orcid: "ORCID iD",
  email: "Email",
};

/** `did:key:z6MkhaXg…2doK` — enough to recognise a DID without a 50-character line. */
export function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 16)}…${did.slice(-6)}`;
}

/** What to call an author when there is no name: their identifier, shortened. */
export function authorLabel(author: DraftAuthor): string {
  if (author.name.trim() !== "") {
    return author.name.trim();
  }
  if (author.isSubmitter) {
    return "You";
  }
  if (author.identifier === null) {
    return "Unknown author";
  }
  return author.kind === "did" ? shortDid(author.identifier) : author.identifier;
}

/** Up to two capital letters for an avatar, or `null` when the label offers no letters. */
export function initials(label: string): string | null {
  const words = label.split(/[\s.,_@-]+/).filter((word) => /^\p{L}/u.test(word));
  if (words.length === 0) {
    return null;
  }
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

let authorCounter = 0;

function nextKey(): string {
  authorCounter += 1;
  return `author-${authorCounter}`;
}

export const SUBMITTER_KEY = "submitter";

/** A roster of one: the submitting author, whose DID may not be known yet. */
export function initialAuthors(submitterDid: string | null = null): DraftAuthor[] {
  return [
    {
      key: SUBMITTER_KEY,
      kind: "did",
      identifier: submitterDid,
      did: submitterDid,
      name: "",
      orcid: null,
      creditRoles: [],
      isSubmitter: true,
      match: submitterDid === null ? "unmatched" : "matched",
    },
  ];
}

/**
 * Record the submitter's DID once the device key has been read. A co-author who
 * was added by that same DID in the meantime is folded into the submitter's
 * row (keeping their roles and name), so nobody is listed twice.
 */
export function withSubmitterDid(authors: readonly DraftAuthor[], did: string): DraftAuthor[] {
  const submitter = authors.find((author) => author.isSubmitter);
  if (submitter === undefined || submitter.did === did) {
    return [...authors];
  }
  const duplicates = authors.filter((author) => !author.isSubmitter && author.did === did);
  return authors
    .filter((author) => !duplicates.includes(author))
    .map((author) =>
      author.isSubmitter
        ? {
            ...author,
            identifier: did,
            did,
            match: "matched" as const,
            name: author.name || duplicates.find((d) => d.name !== "")?.name || "",
            creditRoles: sortCreditRoles([...author.creditRoles, ...duplicates.flatMap((d) => d.creditRoles)]),
          }
        : author,
    );
}

export type AddResult =
  | { ok: true; authors: DraftAuthor[]; added: DraftAuthor }
  | { ok: false; message: string };

/** Add a co-author, refusing someone already on the list. */
export function addAuthor(
  authors: readonly DraftAuthor[],
  input: string,
  name = "",
): AddResult {
  const parsed = parseIdentifier(input);
  if (!parsed.ok) {
    return parsed;
  }

  const existing = authors.find(
    (author) =>
      (author.identifier === parsed.value && author.kind === parsed.kind) ||
      (parsed.kind === "did" && author.did === parsed.value),
  );
  if (existing !== undefined) {
    return {
      ok: false,
      message: existing.isSubmitter
        ? "That is you, and you are already listed."
        : `${authorLabel(existing)} is already on the list.`,
    };
  }

  const added: DraftAuthor = {
    key: nextKey(),
    kind: parsed.kind,
    identifier: parsed.value,
    did: parsed.kind === "did" ? parsed.value : null,
    name: name.trim().replace(/\s+/g, " "),
    orcid: parsed.kind === "orcid" ? parsed.value : null,
    creditRoles: [],
    isSubmitter: false,
    match: parsed.kind === "did" ? "matched" : "unmatched",
  };
  return { ok: true, authors: [...authors, added], added };
}

/** Remove a co-author. The submitter cannot be removed. */
export function removeAuthor(authors: readonly DraftAuthor[], key: string): DraftAuthor[] {
  return authors.filter((author) => author.key !== key || author.isSubmitter);
}

/** Move an author up (`-1`) or down (`1`) the byline; the ends stay put. */
export function moveAuthor(authors: readonly DraftAuthor[], key: string, delta: -1 | 1): DraftAuthor[] {
  const from = authors.findIndex((author) => author.key === key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= authors.length) {
    return [...authors];
  }
  const next = [...authors];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Add the role if the author lacks it, remove it if they have it. */
export function toggleCreditRole(authors: readonly DraftAuthor[], key: string, role: string): DraftAuthor[] {
  return authors.map((author) => {
    if (author.key !== key || !isCreditRole(role)) {
      return author;
    }
    const has = author.creditRoles.includes(role);
    return {
      ...author,
      creditRoles: sortCreditRoles(has ? author.creditRoles.filter((r) => r !== role) : [...author.creditRoles, role]),
    };
  });
}

// ---------------------------------------------------------------------------
// Matching an ORCID iD or email to an account
// ---------------------------------------------------------------------------

export interface AuthorLookup {
  /** The DID of the account that owns the ORCID iD or email. */
  did: string;
  name?: string | null;
  orcid?: string | null;
}

/**
 * Finds the account behind an ORCID iD or an email, or `null` when there is
 * none. The API has no such lookup in this release, so the step takes one as a
 * prop rather than guessing at an endpoint.
 */
export type ResolveAuthor = (reference: {
  kind: "orcid" | "email";
  value: string;
}) => Promise<AuthorLookup | null>;

export type MatchResult =
  | { ok: true; authors: DraftAuthor[] }
  | { ok: false; authors: DraftAuthor[]; message: string };

/**
 * Apply what a lookup found to the author who was added by ORCID iD or email.
 * `null` (or an answer that is not a DID) leaves them unmatched. A DID already on the list means the same person
 * was added twice by different routes, so the new row is dropped.
 */
export function applyLookup(
  authors: readonly DraftAuthor[],
  key: string,
  lookup: AuthorLookup | null,
): MatchResult {
  const target = authors.find((author) => author.key === key);
  if (target === undefined) {
    return { ok: true, authors: [...authors] };
  }
  if (lookup === null || !DID_PATTERN.test(lookup.did)) {
    return { ok: true, authors: [...authors] };
  }

  const duplicate = authors.find((author) => author.key !== key && author.did === lookup.did);
  if (duplicate !== undefined) {
    return {
      ok: false,
      authors: authors.filter((author) => author.key !== key),
      message: `${authorLabel(duplicate)} is already on the list under a different identifier.`,
    };
  }

  return {
    ok: true,
    authors: authors.map((author) =>
      author.key === key
        ? {
            ...author,
            did: lookup.did,
            name: author.name || lookup.name?.trim() || "",
            orcid: lookup.orcid ?? author.orcid,
            match: "matched" as const,
          }
        : author,
    ),
  };
}

// ---------------------------------------------------------------------------
// Continue, and the signed record
// ---------------------------------------------------------------------------

/** What is still missing before step 4, one sentence each, most important first. */
export function authorsBlockers(authors: readonly DraftAuthor[]): string[] {
  const blockers: string[] = [];

  const submitter = authors.find((author) => author.isSubmitter);
  if (submitter === undefined || submitter.did === null) {
    blockers.push("Sign in so your own DID can be listed as an author.");
  }

  for (const author of authors) {
    if (author.isSubmitter) {
      continue;
    }
    if (author.match === "unmatched") {
      blockers.push(
        `${authorLabel(author)} is not matched to an account yet. Remove them, or add them by DID.`,
      );
    }
  }

  for (const author of authors) {
    if (author.creditRoles.length === 0) {
      blockers.push(`Choose at least one CRediT role for ${authorLabel(author)}.`);
    }
  }

  return blockers;
}

export function canContinueAuthors(authors: readonly DraftAuthor[]): boolean {
  return authorsBlockers(authors).length === 0;
}

/** One author as the signed `paper.version` record lists them. */
export interface RecordAuthor {
  did: string;
  name?: string;
  orcid?: string;
  creditRoles: string[];
  /** 1-based byline position. */
  position: number;
}

/**
 * The byline as the signed `paper.version` record lists it: DIDs in byline
 * order with their roles. Authors with no DID cannot be listed and are left
 * out, so check {@link canContinueAuthors} first.
 */
export function recordAuthors(authors: readonly DraftAuthor[]): RecordAuthor[] {
  const listed: RecordAuthor[] = [];
  for (const author of authors) {
    if (author.did === null) {
      continue;
    }
    const entry: RecordAuthor = {
      did: author.did,
      creditRoles: [...author.creditRoles],
      position: listed.length + 1,
    };
    if (author.name.trim() !== "") {
      entry.name = author.name.trim();
    }
    if (author.orcid !== null) {
      entry.orcid = author.orcid;
    }
    listed.push(entry);
  }
  return listed;
}
