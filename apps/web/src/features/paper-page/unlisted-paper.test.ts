import { describe, expect, it } from "vitest";

import { ApiError } from "../../lib/api";
import { describePaperError } from "../search-page/paper";
import {
  BOB,
  GENESIS_CID,
  GENESIS_SHORT_ID,
  decisionEntry,
  entry,
  versionEntry,
} from "./paper-page-fixtures";
import {
  PAPER_NOT_LISTED,
  formatRemovalDate,
  latestDecision,
  parseManifestPdf,
  pickUnlistedVersion,
  tombstoneOf,
  unlistedBanner,
} from "./unlisted-paper";

/**
 * The data layer behind the hydrated retry on a 404 paper page: the paper's
 * public records are joined into the version an author sees, the decision that
 * holds or removed it, the banner that states where the version stands, and
 * the PDF its manifest names. Pure joins, pinned here.
 */

describe("pickUnlistedVersion", () => {
  it("picks the newest version record when the address names none", () => {
    const version = pickUnlistedVersion(
      [versionEntry(3, 1), versionEntry(4, 2)],
      null,
    );

    expect(version?.n).toBe(2);
    expect(version?.versionCid).toBe("bafyrei-version-2");
    expect(version?.paperCid).toBe(GENESIS_CID);
    expect(version?.shortId).toBe(GENESIS_SHORT_ID);
    expect(version?.title).toBe("Can a Meta-Agent Choose the Safer Branch?");
    expect(version?.authors.map((author) => author.did)).toEqual([
      "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      BOB,
    ]);
    expect(version?.categories).toEqual(["cs.AI", "cs.MA"]);
    expect(version?.licence).toBe("CC-BY-4.0");
    expect(version?.manifestCid).toBe("bafyrei-manifest");
  });

  it("picks the version the address names", () => {
    const version = pickUnlistedVersion(
      [versionEntry(3, 1), versionEntry(4, 2)],
      1,
    );

    expect(version?.n).toBe(1);
    expect(version?.versionCid).toBe("bafyrei-version-1");
  });

  it("is null when the log holds no version record", () => {
    expect(pickUnlistedVersion([decisionEntry("hold")], null)).toBeNull();
    expect(pickUnlistedVersion([], null)).toBeNull();
  });

  it("has no short id when the genesis cid cannot derive one, and keeps the version", () => {
    const version = pickUnlistedVersion(
      [
        entry("paper.version", "bafyrei-version-2", 4, {
          paper: "bafyrei-genesis",
          n: 2,
          title: "A title",
          manifest: "bafyrei-manifest",
        }),
      ],
      null,
    );

    // The caller falls back to the id in the address; the paper still shows.
    expect(version?.paperCid).toBe("bafyrei-genesis");
    expect(version?.shortId).toBeNull();
    expect(version?.title).toBe("A title");
  });

  it("keeps the byline positions the record signed", () => {
    const version = pickUnlistedVersion([versionEntry()], null);

    expect(version?.authors.map((author) => author.position)).toEqual([1, 2]);
    expect(version?.authors[0].creditRoles).toEqual(["Conceptualization"]);
  });
});

describe("latestDecision", () => {
  it("is the highest-seq moderation decision, with its reason and clause", () => {
    const decision = latestDecision([
      decisionEntry("hold", 5, { reason: "First look." }),
      entry("appeal", "bafyrei-appeal", 6, { target: "bafyrei-decision-5" }),
      decisionEntry("list", 9),
    ]);

    expect(decision?.action).toBe("list");
    expect(decision?.decisionCid).toBe("bafyrei-decision-9");
    expect(decision?.clause).toBe("MOD-01");
    expect(decision?.reason).toBe("Outside the category's scope.");
    expect(decision?.decidedAt).toBe("2027-03-05T10:00:00Z");
  });

  it("is null when no decision is on record", () => {
    expect(latestDecision([versionEntry()])).toBeNull();
    expect(latestDecision([])).toBeNull();
  });

  it("leaves out decisions about another version of the paper", () => {
    // v1 (listed) was later tombstoned; v2 is held. Each version's page must
    // state its own decision, not the paper's newest one.
    const entries = [
      versionEntry(1, 1),
      versionEntry(4, 2),
      decisionEntry("hold", 10, { target: "bafyrei-version-2" }),
      decisionEntry("tombstone", 12, { target: "bafyrei-version-1" }),
    ];

    expect(latestDecision(entries, "bafyrei-version-2")?.action).toBe("hold");
    expect(latestDecision(entries, "bafyrei-version-1")?.action).toBe(
      "tombstone",
    );
    // Without a version the paper's newest decision stands.
    expect(latestDecision(entries)?.action).toBe("tombstone");
  });

  it("keeps a decision aimed at the paper or one of its files", () => {
    const entries = [
      versionEntry(4, 2),
      decisionEntry("tombstone", 12, { target: "bafkrei-pdf" }),
    ];

    expect(latestDecision(entries, "bafyrei-version-2")?.action).toBe(
      "tombstone",
    );
  });
});

describe("tombstoneOf", () => {
  it("is the removal facts when the latest decision tombstoned the paper", () => {
    const tombstone = tombstoneOf([
      versionEntry(),
      decisionEntry("hold", 5),
      decisionEntry("tombstone", 12, {
        clause: "MOD-05",
        reason: "Unlawful content.",
      }),
    ]);

    expect(tombstone?.decisionCid).toBe("bafyrei-decision-12");
    expect(tombstone?.clause).toBe("MOD-05");
    expect(tombstone?.reason).toBe("Unlawful content.");
    expect(tombstone?.removedOn).toBe("5 March 2027");
    expect(tombstone?.title).toBe("Can a Meta-Agent Choose the Safer Branch?");
  });

  it("is null when the latest decision is not a takedown", () => {
    expect(
      tombstoneOf([decisionEntry("tombstone", 3), decisionEntry("list", 8)]),
    ).toBeNull();
    expect(tombstoneOf([versionEntry()])).toBeNull();
  });

  it("is the removal of the version asked for, not of another one", () => {
    const entries = [
      versionEntry(1, 1),
      versionEntry(4, 2),
      decisionEntry("hold", 10, { target: "bafyrei-version-2" }),
      decisionEntry("tombstone", 12, { target: "bafyrei-version-1" }),
    ];

    expect(tombstoneOf(entries, 1)?.decisionCid).toBe("bafyrei-decision-12");
    // v2 is merely held: its page is the author's, not a removal marker.
    expect(tombstoneOf(entries, 2)).toBeNull();
    expect(tombstoneOf(entries, null)).toBeNull();
    // A version the log never held was not removed.
    expect(tombstoneOf(entries, 9)).toBeNull();
  });
});

describe("formatRemovalDate", () => {
  it("writes design.md's reading date, in UTC", () => {
    expect(formatRemovalDate("2027-05-04T18:30:00Z")).toBe("4 May 2027");
    expect(formatRemovalDate("2026-11-17T00:00:00Z")).toBe("17 November 2026");
  });

  it("is null for a missing or unreadable timestamp", () => {
    expect(formatRemovalDate(null)).toBeNull();
    expect(formatRemovalDate("not a date")).toBeNull();
  });
});

describe("unlistedBanner", () => {
  it("states a hold with the moderator's reason and the appeal sentence", () => {
    const banner = unlistedBanner(
      "held",
      latestDecision([decisionEntry("hold")]),
    );

    expect(banner.label).toBe("Held from listing");
    expect(banner.detail).toContain("Outside the category's scope.");
    expect(banner.detail).toContain("You can appeal once.");
    expect(banner.tone).toBe("pending");
  });

  it("states a reject as not listed, and that an appeal is possible", () => {
    const banner = unlistedBanner(
      "rejected",
      latestDecision([decisionEntry("reject")]),
    );

    expect(banner.label).toBe("Not listed");
    expect(banner.detail).toContain("You can appeal once.");
    expect(banner.tone).toBe("critical");
  });

  it("says a version in moderation is in moderation", () => {
    const banner = unlistedBanner("moderation", null);

    expect(banner.label).toBe("In moderation");
    expect(banner.tone).toBe("neutral");
  });

  it("says a version awaiting consent is awaiting its co-authors", () => {
    const banner = unlistedBanner("awaiting_consent", null);

    expect(banner.label).toBe("Awaiting co-author consent");
    expect(banner.tone).toBe("pending");
  });

  it("falls back to the honest not-listed-yet line when nothing is known", () => {
    const banner = unlistedBanner(null, null);

    expect(banner.label).toBe("Not listed yet");
    expect(banner.tone).toBe("neutral");
  });

  it("carries the decision's record and clause when one was made", () => {
    const banner = unlistedBanner(
      "held",
      latestDecision([decisionEntry("hold")]),
    );

    expect(banner.decision?.decisionCid).toBe("bafyrei-decision-10");
    expect(banner.decision?.clause).toBe("MOD-01");
  });
});

describe("parseManifestPdf", () => {
  it("finds the manuscript PDF of a signed manifest record", () => {
    const pdf = parseManifestPdf({
      type: "manifest",
      body: {
        files: [
          { path: "code/run.py", cid: "bafkrei-code", role: "code" },
          {
            path: "paper.pdf",
            cid: "bafkrei-pdf",
            role: "manuscript",
            mediaType: "application/pdf",
          },
        ],
      },
    });

    expect(pdf?.name).toBe("paper.pdf");
    expect(pdf?.url).toBe("http://localhost:8000/v1/content/bafkrei-pdf");
  });

  it("is null for a record that is not a manifest, or names no PDF", () => {
    expect(parseManifestPdf({ type: "paper.version", body: {} })).toBeNull();
    expect(
      parseManifestPdf({
        type: "manifest",
        body: { files: [{ path: "code/run.py", cid: "bafkrei-code" }] },
      }),
    ).toBeNull();
  });
});

describe("PAPER_NOT_LISTED", () => {
  it("is the sentence the paper page already uses for a 404 read", () => {
    const error = new ApiError(404, { title: "Not Found", status: 404 });
    expect(PAPER_NOT_LISTED).toBe(describePaperError(error));
  });
});
