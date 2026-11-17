import type { Metadata } from "next";

import { BrandLogo, BrandMark } from "../../../../features/ui-kit";

export const metadata: Metadata = {
  title: "Brand · UI kit",
  description: "Brand mark and logo in every variant and size.",
  robots: { index: false, follow: false },
};

export default function BrandGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / brand</p>
        <h1>Brand</h1>
        <p className="uk-lede">
          The Scholium mark and lockup as inline SVG. Colours read the design
          tokens, so light and dark surfaces re-theme automatically.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="tile">
        <h2 id="tile">Tile variant</h2>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <BrandMark variant="tile" size="sm" />
          <BrandMark variant="tile" size="md" />
          <BrandMark variant="tile" size="lg" />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="glyph">
        <h2 id="glyph">Glyph variant</h2>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <BrandMark variant="glyph" size="sm" />
          <BrandMark variant="glyph" size="md" />
          <BrandMark variant="glyph" size="lg" />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="logo">
        <h2 id="logo">Logo lockup</h2>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <BrandLogo size="sm" />
          <BrandLogo size="md" />
          <BrandLogo size="lg" />
          <BrandLogo size="md" markOnly />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="dark">
        <h2 id="dark">Dark surface</h2>
        <div data-theme="dark" style={{ padding: "1rem" }}>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
            <BrandMark variant="tile" size="md" />
            <BrandMark variant="glyph" size="md" />
            <BrandLogo size="md" />
          </div>
        </div>
      </section>

      <section className="uk-section" aria-labelledby="light-surface">
        <h2 id="light-surface">Light surface</h2>
        <div data-theme="light" style={{ padding: "1rem" }}>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
            <BrandMark variant="tile" size="md" />
            <BrandMark variant="glyph" size="md" />
            <BrandLogo size="md" />
          </div>
        </div>
      </section>
    </>
  );
}
