import type { MetadataRoute } from "next";

/**
 * The web app manifest, served by Next at `/manifest.webmanifest` and linked
 * from every page's `<head>`.
 *
 * The icons are the PNG renditions under `public/brand`, made from the
 * delivered brand files in `docs/brand`: the plain 192 and 512 tiles for
 * launchers that show the icon as-is, and a full-bleed 512 with the mark kept
 * inside the 80% safe zone for launchers that crop it to their own shape.
 * The colours are the brand's: paper (#FBFAF7) behind the splash screen and the
 * scholium blue (#2F4BA0) for the window chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Scholium",
    short_name: "scholium",
    description: "Signed, open preprints and peer review",
    start_url: "/",
    display: "standalone",
    background_color: "#FBFAF7",
    theme_color: "#2F4BA0",
    icons: [
      {
        src: "/brand/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
