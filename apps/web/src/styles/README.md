# Scholium styles

The design system from `docs/design.md` §3, wired once and inherited by every
route through `src/app/globals.css` → `src/styles/index.css`.

## Files

| File | Responsibility |
| --- | --- |
| `tokens.css` | Raw design tokens: colour (light, dark, forced), typography metrics, 4 px spacing unit, radii, motion, material. Framework-agnostic CSS custom properties. |
| `theme.css` | Tailwind v4 `@theme inline` bridge: maps the raw tokens onto `--color-*`, `--font-*`, `--text-*`, `--spacing`, `--radius-*`, `--container-*`, `--ease-*`, `--shadow-popover`. |
| `base.css` | Element defaults, the `.paper-title` / `.reading` / `.meta` / `.mono-id` / `.material-chrome` role classes, focus rings, and the `prefers-reduced-motion` / `-transparency` / `-contrast` fallbacks. |
| `fonts.css` | `@font-face` for the self-hosted variable fonts in `public/fonts/`. |
| `index.css` | Entry point: imports Tailwind, fonts, tokens, theme, base; pins content scanning to `src/**`. |
| `tokens.test.ts` | Contract tests on the CSS sources: exact palette in both themes, Tailwind mappings, fonts, 4 px scale, contrast pairs, reduced motion. |
| `compiled.test.ts` | Runs the real PostCSS + Tailwind pipeline and asserts on the output: every token utility is emitted, utilities read tokens directly, spacing/radius/fonts resolve through tokens. |

`tailwind.config.ts` is the JavaScript mirror of the same tokens for editor
tooling. Tailwind v4 itself is driven by `theme.css`.

## Using the tokens

Prefer utilities that reference the tokens; never hardcode a hex or px value.

```tsx
<article className="rounded-card border border-rule bg-surface p-6">
  <h2 className="text-paper-title text-ink">Can a Meta-Agent Choose…</h2>
  <p className="text-reading text-ink-2 max-w-measure">…</p>
  <p className="text-meta text-ink-2">cs.AI · v2 · 3 days ago</p>
  <span className="text-mono">sch:k3f9-q2xz-7mwd/v2</span>
</article>
```

| Design token | Utilities |
| --- | --- |
| `--bg`, `--surface` | `bg-bg`, `bg-surface` |
| `--ink`, `--ink-2` | `text-ink`, `text-ink-2` |
| `--rule` | `border-rule`, `divide-rule` |
| `--accent` | `text-accent`, `bg-accent`, `border-accent` |
| `--verified`, `--pending`, `--critical`, `--ai` | `text-verified`, `bg-verified-soft`, … |
| `--margin-note` | `bg-margin-note` |

Spacing is a strict 4 px grid: `p-1`=4, `p-2`=8, `p-3`=12, `p-4`=16, `p-6`=24,
`p-8`=32, `p-12`=48, `p-16`=64. Shape is `rounded-control` (6 px) for controls
and `rounded-card` (10 px) for cards; `rounded-pill` for chips and ID pills.

## Rules that keep the design intact

- **Status is never colour alone.** Chips carry an icon + word; the colour is
  reinforcement (design.md §9).
- **Soft tints take `--ink` text.** `--verified-soft` etc. are fills; at 13 px
  `--pending` on `--pending-soft` is below 4.5:1, so carry the status colour in
  the icon and border instead of tinting the word: use
  `bg-verified-soft text-ink` and colour the icon, never `text-verified-soft`
  for the label.
- **`--ai` is reserved** for AI pre-review and must never be used for human
  status.
- **Motion** is 150–200 ms with `var(--ease-decel)`; animate `transform` and
  `opacity` only. Under `prefers-reduced-motion: reduce` the duration tokens
  collapse and transitions are neutralised automatically.
- **Elevation** belongs only to the floating annotation popover
  (`shadow-popover`); everything else uses 1 px `--rule` borders.
- **Focus** is a 2 px `--accent` ring; targets should be at least 44 px.

## Themes

- OS preference applies automatically.
- Force a theme with `data-theme="dark"` / `"light"` on `<html>`.
- `color-scheme` is set per theme, so native controls follow it.
- A theme can also be scoped to a subtree (`<section data-theme="dark">`):
  utilities follow the theme of the element they sit on. That is why
  `theme.css` uses `@theme inline` — a plain `@theme` would resolve
  `--color-ink: var(--ink)` once on `:root` and utilities inside the subtree
  would keep the root theme. Don't remove `inline`.

## Tooling notes

- **Tailwind versions are pinned together.** `tailwindcss`, `@tailwindcss/postcss`
  (`apps/web/package.json`) and `@tailwindcss/node` / `@tailwindcss/oxide` (root
  `package.json` `overrides`) are all `4.0.0`. `@tailwindcss/postcss@4.0.0`
  declares `^4.0.0` for the last two, so without the overrides npm installs a
  newer pair whose scanner API is incompatible and the whole CSS pipeline throws
  `Missing field 'negated' on ScannerOptions.sources`. npm only honours
  `overrides` at the workspace root. To move Tailwind forward, bump all four
  together and drop the overrides.
- **Utility scanning ignores `.gitignore`d paths.** Tailwind's scanner skips
  anything git ignores, and agent worktrees live under the ignored
  `.claw-forge/`, so glob/directory `@source`s find nothing there while explicit
  file `@source`s do. Normal checkouts are unaffected; `compiled.test.ts` uses an
  explicit probe file for this reason.

## Fonts

Source Serif 4 (reading + titles), Inter (UI) and JetBrains Mono (IDs/code) are
self-hosted variable fonts in `public/fonts/`, referenced by absolute URL so
Next's CSS loader leaves them untouched. Provenance and the OFL licence are in
`public/fonts/README.md`.
