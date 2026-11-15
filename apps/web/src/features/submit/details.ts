/**
 * Step 2 of the submit wizard: Details (docs/design.md §5.4).
 *
 * "Title, abstract (pre-filled from the file), categories, licence — licence
 * picker explains each option in one line and flags journal-compatibility."
 *
 * This module is the data and the rules; `details-step.tsx` is the form. The
 * licence ids are the values that travel into the signed record's `licence`
 * field (the API's fixtures use `CC-BY-4.0`), so the display names may change
 * without changing what is signed.
 */

/** How a licence sits with the journal or funder the author may publish in. */
export type JournalFit = "accepted" | "check";

export interface LicenceOption {
  /** The value stored in the signed record, e.g. `CC-BY-4.0`. */
  id: string;
  /** The name an author recognises, e.g. `CC BY 4.0`. */
  label: string;
  /** One line saying what the author gives away and what readers may do. */
  summary: string;
  /** The one-line journal-compatibility flag beside the option. */
  journal: JournalFit;
}

/** The default licence (PRD PUB-9: "default CC BY 4.0"). */
export const DEFAULT_LICENCE_ID = "CC-BY-4.0";

/**
 * The licences an author may choose at submission. Kept short and in the
 * order a researcher is most likely to want them; the first is the default.
 */
export const LICENCES: readonly LicenceOption[] = [
  {
    id: DEFAULT_LICENCE_ID,
    label: "CC BY 4.0",
    summary: "Reuse with credit, including commercially. Accepted by most journals and funders.",
    journal: "accepted",
  },
  {
    id: "CC-BY-SA-4.0",
    label: "CC BY-SA 4.0",
    summary: "Reuse with credit, but new works must carry the same licence. Some journals cannot accept it.",
    journal: "check",
  },
  {
    id: "CC-BY-NC-4.0",
    label: "CC BY-NC 4.0",
    summary: "Reuse with credit for non-commercial use only. Many open-access mandates exclude it.",
    journal: "check",
  },
  {
    id: "CC-BY-NC-ND-4.0",
    label: "CC BY-NC-ND 4.0",
    summary: "Reuse unchanged, with credit, non-commercially. Few journals or funders accept it.",
    journal: "check",
  },
  {
    id: "CC0-1.0",
    label: "CC0 1.0",
    summary: "Dedicated to the public domain. Anyone may reuse it without credit.",
    journal: "accepted",
  },
];

/** The licence behind an id, or `undefined` for a value this release does not know. */
export function licenceById(id: string): LicenceOption | undefined {
  return LICENCES.find((licence) => licence.id === id);
}

export interface CategoryOption {
  /** arXiv-style identifier, e.g. `cs.AI`; this is what the record stores. */
  id: string;
  /** The plain-language name, read out by screen readers with the id. */
  name: string;
}

export interface CategoryGroup {
  id: string;
  label: string;
  categories: readonly CategoryOption[];
}

/**
 * The launch categories, grouped the way arXiv groups them. A fixed list means
 * two authors cannot spell the same field two ways, and a moderator can be
 * named per group.
 */
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  {
    id: "cs",
    label: "Computer science",
    categories: [
      { id: "cs.AI", name: "Artificial intelligence" },
      { id: "cs.CL", name: "Computation and language" },
      { id: "cs.CR", name: "Cryptography and security" },
      { id: "cs.CV", name: "Computer vision" },
      { id: "cs.HC", name: "Human–computer interaction" },
      { id: "cs.IR", name: "Information retrieval" },
      { id: "cs.LG", name: "Machine learning" },
      { id: "cs.MA", name: "Multiagent systems" },
      { id: "cs.SE", name: "Software engineering" },
    ],
  },
  {
    id: "stat",
    label: "Statistics",
    categories: [
      { id: "stat.ML", name: "Machine learning" },
      { id: "stat.ME", name: "Methodology" },
      { id: "stat.TH", name: "Statistics theory" },
    ],
  },
  {
    id: "math",
    label: "Mathematics",
    categories: [
      { id: "math.OC", name: "Optimization and control" },
      { id: "math.ST", name: "Statistics theory" },
      { id: "math.CO", name: "Combinatorics" },
    ],
  },
  {
    id: "physics",
    label: "Physics",
    categories: [
      { id: "physics.comp-ph", name: "Computational physics" },
      { id: "physics.soc-ph", name: "Physics and society" },
    ],
  },
  {
    id: "q-bio",
    label: "Quantitative biology",
    categories: [
      { id: "q-bio.NC", name: "Neurons and cognition" },
      { id: "q-bio.QM", name: "Quantitative methods" },
    ],
  },
  {
    id: "eess",
    label: "Electrical engineering and systems science",
    categories: [
      { id: "eess.AS", name: "Audio and speech processing" },
      { id: "eess.SP", name: "Signal processing" },
    ],
  },
  {
    id: "econ",
    label: "Economics",
    categories: [
      { id: "econ.EM", name: "Econometrics" },
      { id: "econ.GN", name: "General economics" },
    ],
  },
];

/** Every category across the groups, in the order they are shown. */
export const CATEGORIES: readonly CategoryOption[] = CATEGORY_GROUPS.flatMap((group) => group.categories);

/** At most three categories: enough to place a paper without scattering it. */
export const MAX_CATEGORIES = 3;

export const TITLE_MAX_LENGTH = 300;
export const ABSTRACT_MAX_LENGTH = 5_000;

/** The values step 2 collects. Later steps build the record body from these. */
export interface DetailsValues {
  title: string;
  abstract: string;
  /** Category ids, in the order the author picked them. */
  categories: string[];
  /** A licence id from `LICENCES`; `DEFAULT_LICENCE_ID` until the author changes it. */
  licence: string;
}

/** A blank Details step: no title or abstract, and the default licence already chosen. */
export function emptyDetails(): DetailsValues {
  return { title: "", abstract: "", categories: [], licence: DEFAULT_LICENCE_ID };
}

/**
 * Add `id` to the picks, remove it if it is already there, or leave the list
 * alone when three are already chosen. Order of the existing picks is kept.
 */
export function toggleCategory(categories: readonly string[], id: string): string[] {
  if (categories.includes(id)) {
    return categories.filter((category) => category !== id);
  }
  if (categories.length >= MAX_CATEGORIES) {
    return [...categories];
  }
  return [...categories, id];
}

/**
 * What still stands in the way of continuing, in the order the author should
 * fix it. Empty when the step is complete. The licence is never listed: the
 * picker always has one selected.
 */
export function detailsBlockers(values: DetailsValues): string[] {
  const blockers: string[] = [];
  const title = values.title.trim();
  const abstract = values.abstract.trim();

  if (title === "") {
    blockers.push("Add a title to continue.");
  } else if (title.length > TITLE_MAX_LENGTH) {
    blockers.push(`Shorten the title to ${TITLE_MAX_LENGTH} characters or fewer.`);
  }

  if (abstract === "") {
    blockers.push("Add an abstract to continue.");
  } else if (abstract.length > ABSTRACT_MAX_LENGTH) {
    blockers.push(`Shorten the abstract to ${ABSTRACT_MAX_LENGTH} characters or fewer.`);
  }

  if (values.categories.length === 0) {
    blockers.push("Choose at least one category to continue.");
  } else if (values.categories.length > MAX_CATEGORIES) {
    blockers.push(`Choose no more than ${MAX_CATEGORIES} categories.`);
  } else if (values.categories.some((id) => !CATEGORIES.some((category) => category.id === id))) {
    blockers.push("Remove the category this release does not list.");
  }

  if (licenceById(values.licence) === undefined) {
    blockers.push("Choose a licence to continue.");
  }

  return blockers;
}

/** True when step 2 can be left for step 3. */
export function canContinueDetails(values: DetailsValues): boolean {
  return detailsBlockers(values).length === 0;
}
