import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  ManifestUnavailableError,
  createNodeManifestLoader,
  describeManifestError,
  manifestPath,
  parseManifestResponse,
  type ManifestClient,
} from "./manifest-source";
import {
  MANIFEST_CID,
  SIGNED_BYTES,
  VERSION_CID,
  VERSION_ID,
  manifestBody,
  versionRef,
} from "./verify-fixtures";
import { fileCid } from "../paper-proof/files";

const REF = versionRef();

describe("manifestPath", () => {
  it("is the catalog route for one version, with the id encoded", () => {
    expect(manifestPath(REF)).toBe("/papers/sch%3A6sel-2dio-orm6/v/2/manifest");
  });
});

describe("parseManifestResponse", () => {
  it("reads the signed values of every file, in the signed order", () => {
    const manifest = parseManifestResponse(manifestBody(), REF);

    expect(manifest.ref).toEqual(REF);
    expect(manifest.versionCid).toBe(VERSION_CID);
    expect(manifest.manifestCid).toBe(MANIFEST_CID);
    expect(manifest.files).toEqual([
      {
        path: "main.pdf",
        cid: fileCid(SIGNED_BYTES["main.pdf"]),
        size: SIGNED_BYTES["main.pdf"].length,
        role: "manuscript",
      },
      {
        path: "data/results.csv",
        cid: fileCid(SIGNED_BYTES["data/results.csv"]),
        size: SIGNED_BYTES["data/results.csv"].length,
        role: "dataset",
      },
    ]);
  });

  it("does not carry the node's own fields (licence, scan status) into the signed list", () => {
    const [file] = parseManifestResponse(manifestBody(), REF).files;
    expect(Object.keys(file).sort()).toEqual(["cid", "path", "role", "size"]);
  });

  it("accepts the alias names for the paper and the version", () => {
    const body = manifestBody();
    delete body.shortId;
    delete body.n;
    expect(parseManifestResponse(body, REF).files).toHaveLength(2);
  });

  it("tolerates a node that does not say the record ids", () => {
    const body = manifestBody();
    delete body.versionCid;
    delete body.manifestCid;
    const manifest = parseManifestResponse(body, REF);
    expect(manifest.versionCid).toBeNull();
    expect(manifest.manifestCid).toBeNull();
  });

  it("refuses an answer for another version: it would make a genuine file look forged", () => {
    expect(() => parseManifestResponse(manifestBody({ n: 3, version: 3 }), REF)).toThrow(
      /different version than sch:6sel-2dio-orm6\/v2/,
    );
    expect(() => parseManifestResponse(manifestBody({ shortId: "sch:abcd-efgh-ijkl", paper: "x" }), REF)).toThrow(
      ManifestUnavailableError,
    );
  });

  it("refuses an answer that does not say which version it is for", () => {
    const body = manifestBody();
    for (const key of ["paper", "shortId", "n", "version"]) delete body[key];
    expect(() => parseManifestResponse(body, REF)).toThrow(ManifestUnavailableError);
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["a list", []],
  ])("refuses a body that is %s", (_name, body) => {
    expect(() => parseManifestResponse(body, REF)).toThrow(ManifestUnavailableError);
  });

  it("refuses an empty or missing file list", () => {
    expect(() => parseManifestResponse(manifestBody({ files: [] }), REF)).toThrow(/lists no files/);
    expect(() => parseManifestResponse(manifestBody({ files: undefined }), REF)).toThrow(/lists no files/);
  });

  it("refuses a file id that is not a canonical raw file id", () => {
    const [good] = (manifestBody().files as Array<Record<string, unknown>>);
    const bad = (cid: unknown) => manifestBody({ files: [{ ...good, cid }] });

    // A record id (dag-cbor), not a file id.
    expect(() => parseManifestResponse(bad(MANIFEST_CID), REF)).toThrow(ManifestUnavailableError);
    // The right id in upper case is not the canonical spelling.
    expect(() => parseManifestResponse(bad(String(good.cid).toUpperCase()), REF)).toThrow(/no valid file id/);
    for (const cid of [null, 42, "", "bafkrei", "not a cid"]) {
      expect(() => parseManifestResponse(bad(cid), REF), String(cid)).toThrow(ManifestUnavailableError);
    }
  });

  it("refuses a file with no path or a bad size", () => {
    const [good] = (manifestBody().files as Array<Record<string, unknown>>);
    for (const patch of [{ path: "" }, { path: 7 }, { size: -1 }, { size: 1.5 }, { size: "12" }, { size: undefined }]) {
      expect(
        () => parseManifestResponse(manifestBody({ files: [{ ...good, ...patch }] }), REF),
        JSON.stringify(patch),
      ).toThrow(ManifestUnavailableError);
    }
    expect(() => parseManifestResponse(manifestBody({ files: ["main.pdf"] }), REF)).toThrow(ManifestUnavailableError);
  });

  it("names the file whose entry was unreadable", () => {
    const [good] = (manifestBody().files as Array<Record<string, unknown>>);
    expect(() => parseManifestResponse(manifestBody({ files: [{ ...good, size: -1 }] }), REF)).toThrow(/main\.pdf/);
  });
});

describe("createNodeManifestLoader", () => {
  it("reads the version's manifest publicly, with no account and the caller's abort signal", async () => {
    const get = vi.fn(async (..._args: unknown[]) => manifestBody());
    const signal = new AbortController().signal;

    const manifest = await createNodeManifestLoader({ get } as unknown as ManifestClient)(REF, signal);

    expect(get).toHaveBeenCalledWith("/papers/sch%3A6sel-2dio-orm6/v/2/manifest", { auth: false, signal });
    expect(manifest.files.map((file) => file.path)).toEqual(["main.pdf", "data/results.csv"]);
  });

  it("lets a failed request through for the caller to describe", async () => {
    const failure = new NetworkError("http://node/x");
    const get = vi.fn(async (..._args: unknown[]) => Promise.reject(failure));
    const loader = createNodeManifestLoader({ get } as unknown as ManifestClient);
    await expect(loader(REF)).rejects.toBe(failure);
  });
});

function apiError(status: number, detail?: string): ApiError {
  return new ApiError(status, { status, title: "Title", ...(detail ? { detail } : {}) });
}

describe("describeManifestError", () => {
  it("says an unreachable node may mean the reader is offline", () => {
    expect(describeManifestError(new NetworkError("http://node/x"), REF)).toBe(
      "Scholium could not reach the node. You may be offline.",
    );
  });

  it("says a version the node does not hold is not published here, by id", () => {
    const message = describeManifestError(apiError(404), REF);
    expect(message).toContain(`no published ${VERSION_ID}`);
    expect(message).toContain("Check the id");
  });

  it("shows the node's own explanation for other failures", () => {
    expect(describeManifestError(apiError(503, "Down for maintenance."), REF)).toBe("Down for maintenance.");
  });

  it("shows an unusable answer's own sentence, and has a fallback for anything else", () => {
    expect(describeManifestError(new ManifestUnavailableError("The node lists no files."), REF)).toBe(
      "The node lists no files.",
    );
    expect(describeManifestError(new Error("boom"), REF)).toBe("boom");
    expect(describeManifestError("???", REF)).toBe("The signed files could not be loaded.");
  });
});
