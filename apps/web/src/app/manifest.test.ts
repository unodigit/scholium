// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import manifest from "./manifest";

/**
 * The web app manifest Next serves at `/manifest.webmanifest`, and the PNG
 * renditions in `public/brand` that it points at. The renditions are made from
 * the delivered brand files, so the tests check what a launcher or a lockup
 * consumer would rely on: that each icon is the size the manifest declares,
 * that the maskable icon's mark survives a circular crop, and that each logo
 * is cropped to its artwork with the same margin on every side.
 */

const publicDir = (path: string) =>
  fileURLToPath(new URL(`../../public/${path}`, import.meta.url));

/** A decoded 8-bit, non-interlaced PNG: `channels` bytes per pixel, row-major. */
interface Png {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

function decodePng(file: Buffer): Png {
  expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  let header: { width: number; height: number; channels: number } | undefined;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      expect([bitDepth, interlace]).toEqual([8, 0]);
      expect([2, 6], "RGB or RGBA").toContain(colorType);
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        channels: colorType === 2 ? 3 : 4,
      };
    } else if (type === "IDAT") {
      idat.push(body);
    }
    offset += 12 + length;
  }
  expect(header, "PNG has an IHDR chunk").toBeDefined();
  const { width, height, channels } = header!;

  // Undo the per-row filters (PNG spec §9): None, Sub, Up, Average, Paeth.
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const left = i >= channels ? data[y * stride + i - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + i] = (x + predicted) & 0xff;
    }
  }
  return { width, height, channels, data };
}

const readPng = (path: string) => decodePng(readFileSync(publicDir(path)));

const pixel = ({ data, width, channels }: Png, x: number, y: number) =>
  Array.from(data.subarray((y * width + x) * channels, (y * width + x) * channels + 3));

/** Largest per-channel difference between two RGB triples. */
const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe("the web app manifest", () => {
  const app = manifest();

  it("names the app and describes it", () => {
    expect(app.name).toBe("Scholium");
    expect(app.short_name).toBe("scholium");
    expect(app.description).toBe("Signed, open preprints and peer review");
  });

  it("opens the paper feed as a standalone app in the brand colours", () => {
    expect(app.start_url).toBe("/papers");
    expect(app.display).toBe("standalone");
    expect(app.background_color).toBe("#FBFAF7");
    expect(app.theme_color).toBe("#2F4BA0");
  });

  it("declares the 192, 512 and maskable 512 icons", () => {
    expect(app.icons).toEqual([
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("points every icon at a PNG of exactly the size it declares", () => {
    for (const icon of app.icons ?? []) {
      const png = readPng(icon.src.replace(/^\//, ""));
      expect(`${png.width}x${png.height}`, icon.src).toBe(icon.sizes);
    }
  });
});

describe("the maskable icon", () => {
  const png = readPng("brand/icon-maskable-512.png");
  const BLUE = [0x2f, 0x4b, 0xa0];

  it("is full-bleed #2F4BA0, so any launcher shape crops to solid colour", () => {
    const last = png.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      expect(pixel(png, x, y)).toEqual(BLUE);
    }
  });

  it("keeps the whole mark inside the 80% safe zone", () => {
    // The safe zone is the circle of diameter 80% centred on the icon.
    const centre = (png.width - 1) / 2;
    const safeRadius = 0.4 * png.width;
    let markPixels = 0;
    let farthest = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (distance(pixel(png, x, y), BLUE) <= 6) continue;
        markPixels++;
        farthest = Math.max(farthest, Math.hypot(x - centre, y - centre));
      }
    }
    expect(markPixels, "the icon is not blank").toBeGreaterThan(10_000);
    expect(farthest).toBeLessThanOrEqual(safeRadius);
  });
});

describe("the logo lockups", () => {
  for (const scheme of ["light", "dark"]) {
    it(`${scheme} is cropped to its artwork with even padding`, () => {
      const png = readPng(`brand/scholium-logo-${scheme}.png`);
      const background = pixel(png, 0, 0);
      let [left, top, right, bottom] = [png.width, png.height, -1, -1];
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          if (distance(pixel(png, x, y), background) <= 32) continue;
          [left, top] = [Math.min(left, x), Math.min(top, y)];
          [right, bottom] = [Math.max(right, x), Math.max(bottom, y)];
        }
      }
      const margins = [left, top, png.width - 1 - right, png.height - 1 - bottom];

      expect(Math.min(...margins), "there is padding").toBeGreaterThan(0);
      expect(Math.max(...margins) - Math.min(...margins), `margins ${margins}`).toBeLessThanOrEqual(1);
      // Cropped, not the 1376x768 JPEG frame it came from.
      expect(png.width).toBeLessThan(1376);
      expect(png.height).toBeLessThan(768);
    });
  }
});
