import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  MetaRefError,
  MetaResponseError,
  anchorSpec,
  contentUrl,
  currentVersionOf,
  describeMetaError,
  formatBytes,
  formatDate,
  formatDateTime,
  isDownloadable,
  licenceLabel,
  loadManifest,
  loadVersions,
  manifestEndpoint,
  metaRefFromSegments,
  normalizeScanStatus,
  paperPath,
  parseManifest,
  parseMetaRef,
  parseVersionAnchor,
  parseVersions,
  roleLabel,
  versionPath,
  versionsEndpoint,
  type ManifestData,
  type MetaClient,
  type VersionsData,
} from "./meta";

const SHORT = "sch:6sel-2dio-orm6";

const VERSIONS_BODY = {
  paper: SHORT,
  shortId: SHORT,
  paperCid: "bafyrei-paper",
  versions: [
    {
      n: 2,
      version: 2,
      cid: "bafyrei-v2",
      versionCid: "bafyrei-v2",
      change_note: "  Fixed the proof of Lemma 2.  ",
      changeNote: "Fixed the proof of Lemma 2.",
      listed_at: "2026-02-01T00:00:00",
      listedAt: "2026-02-01T00:00:00",
      anchor: "pending",
      anchorStatus: "pending",
      anchor_status: "pending",
    },
    {
      n: 1,
      cid: "bafyrei-v1",
      changeNote: null,
      listedAt: "2026-01-01T00:00:00",
      anchor: {
        status: "anchored",
        anchored_at: "2027-03-02T04:00:00Z",
        tx_url: "https://basescan.org/tx/0xabc",
      },
    },
    // Unreadable rows are dropped, not fatal.
    { n: 0, cid: "bafyrei-bad" },
    { version: 3 },
    "not a version",
  ],
};

describe("parseVersions", () => {
  it("reads both API spellings and sorts the timeline oldest first", () => {
    const data = parseVersions(VERSIONS_BODY);

    expect(data.paper).toBe(SHORT);
    expect(data.paperCid).toBe("bafyrei-paper");
    expect(data.versions.map((version) => version.n)).toEqual([1, 2]);

    const [first, second] = data.versions;
    expect(first.cid).toBe("bafyrei-v1");
    expect(first.changeNote).toBeNull();
    expect(first.listedAt).toBe("2026-01-01T00:00:00");
    expect(second.changeNote).toBe("Fixed the proof of Lemma 2.");
    expect(second.listedAt).toBe("2026-02-01T00:00:00");
  });

  it("reads a pending anchor and an anchored one without guessing", () => {
    const data = parseVersions(VERSIONS_BODY);
    expect(data.versions[1].anchor).toEqual({ status: "pending" });
    expect(data.versions[0].anchor).toEqual({
      status: "anchored",
      anchoredAt: "2027-03-02T04:00:00Z",
      txUrl: "https://basescan.org/tx/0xabc",
    });
  });

  it("is an error, never an empty timeline, when the body is not a version list", () => {
    expect(() => parseVersions(null)).toThrow(MetaResponseError);
    expect(() => parseVersions({ versions: "two" })).toThrow(/version list/);
  });

  it("never treats a missing anchor as anything but pending", () => {
    const data = parseVersions({
      versions: [{ n: 1, cid: "bafyrei-v1" }],
    });
    expect(data.versions[0].anchor).toEqual({ status: "pending" });
  });
});

describe("parseVersionAnchor", () => {
  it("reads the anchored object the design shows once it has a usable time", () => {
    expect(
      parseVersionAnchor({
        status: "anchored",
        anchored_at: "2027-03-02T04:00:00Z",
        tx_url: "https://example.org/tx/1",
      }),
    ).toEqual({
      status: "anchored",
      anchoredAt: "2027-03-02T04:00:00Z",
      txUrl: "https://example.org/tx/1",
    });
  });

  it("keeps an unrecognised or undated claim pending, never more verified", () => {
    expect(parseVersionAnchor("pending")).toEqual({ status: "pending" });
    expect(parseVersionAnchor("anchored")).toEqual({ status: "pending" });
    expect(parseVersionAnchor({ status: "anchored" })).toEqual({ status: "pending" });
    expect(parseVersionAnchor({ status: "anchored", anchored_at: "not a date" })).toEqual({
      status: "pending",
    });
    expect(parseVersionAnchor(undefined)).toEqual({ status: "pending" });
  });

  it("renders only https transaction links", () => {
    const anchored = parseVersionAnchor({
      status: "anchored",
      anchored_at: "2027-03-02T04:00:00Z",
      tx_url: "javascript:alert(1)",
    });
    expect(anchored).toEqual({
      status: "anchored",
      anchoredAt: "2027-03-02T04:00:00Z",
      txUrl: null,
    });
  });
});

const MANIFEST_BODY = {
  paper: SHORT,
  shortId: SHORT,
  versionCid: "bafyrei-v2",
  n: 2,
  version: 2,
  manifestCid: "bafyrei-manifest",
  licence: "CC-BY-4.0",
  files: [
    {
      path: "paper.pdf",
      cid: "bafkrei-pdf",
      size: 1048576,
      mediaType: "application/pdf",
      role: "manuscript",
      licence: "CC-BY-4.0",
      scanStatus: "passed",
      scan_status: "passed",
    },
    {
      path: "code/repro.zip",
      cid: "bafkrei-code",
      size: 2048,
      mediaType: "application/zip",
      role: "reproduction-log",
      scan_status: "scanning",
    },
    // No path, no id or no size: of no use to a reader.
    { path: "", cid: "bafkrei-x", size: 1 },
    { path: "no-id.pdf", size: 1 },
    { path: "no-size.pdf", cid: "bafkrei-y" },
  ],
};

describe("parseManifest", () => {
  it("reads the files, their size and role, and the version's licence", () => {
    const data = parseManifest(MANIFEST_BODY);

    expect(data.n).toBe(2);
    expect(data.versionCid).toBe("bafyrei-v2");
    expect(data.manifestCid).toBe("bafyrei-manifest");
    expect(data.licence).toBe("CC-BY-4.0");
    expect(data.files.map((file) => file.path)).toEqual(["paper.pdf", "code/repro.zip"]);

    const [manuscript, code] = data.files;
    expect(manuscript).toMatchObject({
      cid: "bafkrei-pdf",
      size: 1048576,
      mediaType: "application/pdf",
      role: "manuscript",
      scanStatus: "passed",
    });
    // A file carries no licence of its own: the version's licence is repeated.
    expect(code.licence).toBe("CC-BY-4.0");
    expect(code.scanStatus).toBe("scanning");
  });

  it("is an error when the body is not a file list", () => {
    expect(() => parseManifest({})).toThrow(/file list/);
    expect(() => parseManifest("nope")).toThrow(MetaResponseError);
  });

  it("keeps a file whose scan status the node did not state, calling it unknown", () => {
    const data = parseManifest({
      licence: null,
      files: [{ path: "a.bin", cid: "bafkrei-a", size: 1 }],
    });
    expect(data.files[0].scanStatus).toBe("unknown");
    expect(data.files[0].licence).toBeNull();
  });
});

describe("normalizeScanStatus", () => {
  it("accepts the known verdicts in any case and spelling", () => {
    expect(normalizeScanStatus("passed")).toBe("passed");
    expect(normalizeScanStatus("SCANNING")).toBe("scanning");
    expect(normalizeScanStatus("scan-failed")).toBe("unknown");
  });

  it("calls anything else unknown rather than inventing a verdict", () => {
    expect(normalizeScanStatus("quarantined")).toBe("unknown");
    expect(normalizeScanStatus(null)).toBe("unknown");
    expect(normalizeScanStatus(42)).toBe("unknown");
  });

  it("links only a file the node will serve", () => {
    expect(isDownloadable({ scanStatus: "passed" })).toBe(true);
    expect(isDownloadable({ scanStatus: "scanning" })).toBe(false);
    expect(isDownloadable({ scanStatus: "failed" })).toBe(false);
    expect(isDownloadable({ scanStatus: "missing" })).toBe(false);
    expect(isDownloadable({ scanStatus: "unknown" })).toBe(false);
  });
});

describe("endpoints and links", () => {
  it("builds the two catalog paths under /v1 for the shared client", () => {
    expect(versionsEndpoint(SHORT)).toBe(`/papers/${encodeURIComponent(SHORT)}/versions`);
    expect(manifestEndpoint(SHORT, 2)).toBe(`/papers/${encodeURIComponent(SHORT)}/v/2/manifest`);
  });

  it("builds an absolute content URL on the node", () => {
    expect(contentUrl("bafkrei-pdf", "https://node.example/")).toBe(
      "https://node.example/v1/content/bafkrei-pdf",
    );
  });

  it("builds the paper page's version paths without the sch: prefix", () => {
    expect(paperPath(SHORT)).toBe("/p/6sel-2dio-orm6");
    expect(versionPath(SHORT, 2)).toBe("/p/6sel-2dio-orm6/v2");
  });
});

describe("loadVersions and loadManifest", () => {
  it("reads through the shared client, public and uncached", async () => {
    const get = vi.fn(async () => VERSIONS_BODY);
    const data = await loadVersions(SHORT, undefined, {
      get,
    } as unknown as MetaClient);

    expect(get).toHaveBeenCalledWith(versionsEndpoint(SHORT), {
      auth: false,
      cache: "no-store",
      signal: undefined,
    });
    expect(data.versions).toHaveLength(2);

    const manifestGet = vi.fn(async () => MANIFEST_BODY);
    const manifest = await loadManifest(SHORT, 2, undefined, {
      get: manifestGet,
    } as unknown as MetaClient);
    expect(manifestGet).toHaveBeenCalledWith(manifestEndpoint(SHORT, 2), {
      auth: false,
      cache: "no-store",
      signal: undefined,
    });
    expect(manifest.files).toHaveLength(2);
  });
});

describe("describeMetaError", () => {
  it("turns a 404 into the fact that this node has nothing", () => {
    const notFound = new ApiError(404, { status: 404, title: "Not Found" });
    expect(describeMetaError(notFound, "versions")).toMatch(/no listed versions/);
    expect(describeMetaError(notFound, "files")).toMatch(/no files/);
  });

  it("says when the node could not be reached, and asks to wait when throttled", () => {
    expect(
      describeMetaError(new NetworkError("http://localhost:8000"), "files"),
    ).toMatch(/Couldn’t reach the node/);
    expect(
      describeMetaError(new ApiError(429, { status: 429 }), "versions"),
    ).toMatch(/Too many requests/);
  });

  it("uses the node's own words for other failures, and the parser's for a bad body", () => {
    expect(
      describeMetaError(new ApiError(503, { status: 503, detail: "down for maintenance" }), "files"),
    ).toBe("down for maintenance");
    expect(describeMetaError(new MetaResponseError("Bad answer."), "versions")).toBe("Bad answer.");
  });
});

describe("words and formats", () => {
  it("formats sizes in binary units a reader knows", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1048576)).toBe("1 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GiB");
    expect(formatBytes(Number.NaN)).toBe("Unknown size");
  });

  it("formats dates in UTC, the same words in every locale", () => {
    expect(formatDate("2027-03-02T04:00:00Z")).toBe("2 Mar 2027");
    expect(formatDateTime("2027-03-02T04:00:00Z")).toBe("2 Mar 2027 04:00 UTC");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("prints a licence identifier as words, and says when there is none", () => {
    expect(licenceLabel("CC-BY-4.0")).toBe("CC BY 4.0");
    expect(licenceLabel("cc-by-4.0")).toBe("CC BY 4.0");
    expect(licenceLabel("MIT")).toBe("MIT");
    expect(licenceLabel("Proprietary-1.0")).toBe("Proprietary-1.0");
    expect(licenceLabel("")).toBe("No licence stated");
    expect(licenceLabel(null)).toBe("No licence stated");
  });

  it("names the file roles the manifest uses and capitalises the rest", () => {
    expect(roleLabel("manuscript")).toBe("Manuscript");
    expect(roleLabel("reproduction-log")).toBe("Reproduction log");
    expect(roleLabel("supplemental_material")).toBe("Supplemental material");
    expect(roleLabel("")).toBe("File");
  });

  it("writes the anchor as a state, with the design's wording", () => {
    expect(anchorSpec({ status: "pending" })).toMatchObject({
      label: "Anchor pending",
      icon: "pending",
      tone: "pending",
    });
    expect(
      anchorSpec({
        status: "anchored",
        anchoredAt: "2027-03-02T04:00:00Z",
        txUrl: null,
      }),
    ).toMatchObject({
      label: "Anchored 2 Mar 2027 04:00 UTC",
      icon: "check",
      tone: "verified",
    });
  });
});

describe("paper refs", () => {
  it("parses a paper and a version id, and the route segments that name them", () => {
    expect(parseMetaRef(SHORT)).toEqual({ shortId: SHORT, version: null, schId: SHORT });
    expect(parseMetaRef(`${SHORT}/v2`)).toEqual({
      shortId: SHORT,
      version: 2,
      schId: `${SHORT}/v2`,
    });
    expect(metaRefFromSegments(["6sel-2dio-orm6"])).toEqual({
      shortId: SHORT,
      version: null,
      schId: SHORT,
    });
    expect(metaRefFromSegments(["6sel-2dio-orm6", "v3"]).version).toBe(3);
    expect(metaRefFromSegments([encodeURIComponent(SHORT), "v2"]).shortId).toBe(SHORT);
  });

  it("rejects a malformed id, a bad checksum and the wrong number of segments", () => {
    expect(() => parseMetaRef("not-an-id")).toThrow(MetaRefError);
    expect(() => parseMetaRef("sch:aaaa-aaaa-aaab")).toThrow(/checksum/);
    expect(() => metaRefFromSegments([])).toThrow(MetaRefError);
    expect(() => metaRefFromSegments(["6sel-2dio-orm6", "v2", "extra"])).toThrow(MetaRefError);
  });

  it("shows the newest listed version unless one is asked for", () => {
    const data = parseVersions(VERSIONS_BODY) as VersionsData;
    expect(currentVersionOf(data, null)).toBe(2);
    expect(currentVersionOf(data, 1)).toBe(1);
    expect(currentVersionOf(null, null)).toBeNull();
    const empty: VersionsData = { paper: SHORT, paperCid: null, versions: [] };
    expect(currentVersionOf(empty, null)).toBeNull();
  });
});

describe("types stay useful to a host", () => {
  it("accepts a hand-built manifest", () => {
    const manifest: ManifestData = {
      paper: SHORT,
      versionCid: null,
      n: 1,
      manifestCid: null,
      licence: null,
      files: [
        {
          path: "paper.pdf",
          cid: "bafkrei-pdf",
          size: 1,
          mediaType: null,
          role: "manuscript",
          licence: null,
          scanStatus: "passed",
        },
      ],
    };
    expect(manifest.files[0].path).toBe("paper.pdf");
  });
});
