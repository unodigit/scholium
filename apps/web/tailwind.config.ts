import type { Config } from "tailwindcss";

/**
 * Tailwind CSS v4 is CSS-first: the authoritative theme lives in
 * `src/styles/theme.css` (`@theme`) and the raw design tokens in
 * `src/styles/tokens.css`. Tailwind generates every utility from those custom
 * properties, so light/dark/forced themes flow through with no `dark:`
 * variants.
 *
 * This config is the JavaScript-side mirror of the same tokens. It keeps
 * editor tooling, class-name completions and any config-aware plugin in sync
 * with docs/design.md §3, and pins the content globs. Values are references to
 * the CSS variables — never duplicated hex codes.
 */
const config = {
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        rule: "var(--rule)",
        accent: "var(--accent)",
        verified: "var(--verified)",
        pending: "var(--pending)",
        critical: "var(--critical)",
        ai: "var(--ai)",
        "margin-note": "var(--margin-note)",

        // Derived roles
        "accent-ink": "var(--accent-ink)",
        "accent-soft": "var(--accent-soft)",
        "verified-soft": "var(--verified-soft)",
        "pending-soft": "var(--pending-soft)",
        "critical-soft": "var(--critical-soft)",
        "ai-soft": "var(--ai-soft)",
        "margin-note-ink": "var(--margin-note-ink)",
        scrim: "var(--scrim)",
      },
      fontFamily: {
        sans: ["var(--family-sans)"],
        serif: ["var(--family-serif)"],
        mono: ["var(--family-mono)"],
      },
      fontSize: {
        "paper-title": [
          "var(--type-title)",
          {
            lineHeight: "var(--leading-title)",
            letterSpacing: "var(--tracking-title)",
            fontWeight: "var(--weight-title)",
          },
        ],
        reading: ["var(--type-reading)", { lineHeight: "var(--leading-reading)" }],
        ui: ["var(--type-ui)", { lineHeight: "var(--leading-ui)" }],
        meta: ["var(--type-meta)", { lineHeight: "var(--leading-meta)" }],
        mono: ["var(--type-mono)", { lineHeight: "var(--leading-mono)" }],
      },
      // 4 px base grid: 1=4, 2=8, 3=12, 4=16, 6=24, 8=32, 12=48, 16=64.
      spacing: {
        1: "0.25rem",
        2: "0.5rem",
        3: "0.75rem",
        4: "1rem",
        6: "1.5rem",
        8: "2rem",
        12: "3rem",
        16: "4rem",
      },
      borderRadius: {
        control: "var(--corner-control)",
        card: "var(--corner-card)",
        pill: "var(--corner-pill)",
      },
      maxWidth: {
        reading: "var(--reading-column)",
        margin: "var(--margin-panel)",
        measure: "var(--measure-reading)",
      },
      width: {
        reading: "var(--reading-column)",
        margin: "var(--margin-panel)",
      },
      // docs/design.md §10: phone 640, tablet 1024, desktop-with-margin 1280.
      screens: {
        sm: "40rem",
        lg: "64rem",
        xl: "80rem",
      },
      boxShadow: {
        // Only the floating annotation popover uses elevation (design.md §3).
        popover: "var(--popover-shadow)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
      },
      transitionTimingFunction: {
        out: "var(--ease-decel)",
        "in-out": "var(--ease-symmetric)",
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
