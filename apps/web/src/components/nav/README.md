# Global navigation (`components/nav`)

The app-wide navigation from `docs/design.md` §4 (IA), §5.1 (feed header
mock) and §10 (responsive rules). One component, two shapes, switched at the
640px breakpoint:

- **≥640px** — sticky translucent header: `scholium` wordmark · search field ·
  Categories · Submit · notifications · avatar (`hidden sm:flex`).
- **<640px** — fixed bottom tab bar: Home · Search · Submit · Inbox · Me
  (`flex sm:hidden`).

## Mounting

Mount once in a route-group layout and keep the auth screens
(`src/app/(web-auth)/`) bare:

```tsx
import { GlobalNav, NavTabBarSpacer } from "../../components/nav";

export default function FeedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GlobalNav />
      <main>{children}</main>
      {/* keeps content clear of the fixed bar on phones */}
      <NavTabBarSpacer />
    </>
  );
}
```

`NavTabBarSpacer` is exactly the bar's height (`56px + env(safe-area-inset-
bottom)`) and hidden from 640px up. For anchor links that must land below the
sticky header, give targets `scroll-margin-top: calc(64px + 8px)`.

## Behaviour with no props

| Part | Default |
| --- | --- |
| Sign-in state | Derived from the shared token store (`src/lib/api`) after mount, so SSR HTML matches and sign-in/out anywhere updates the nav live. `signedIn` pins it. |
| Unread badge | Fetched once from `GET /v1/me/notifications` when signed in (`countUnread` of the rows); failures are silent. `unreadCount` pins or `loadNotifications` replaces the loader (`null` disables). |
| Categories | `DEFAULT_CATEGORIES` — the launch taxonomy `cs.AI · cs.LG · cs.MA` from design.md §5.1. Pass `categories` when a server taxonomy exists. |
| Avatar | Initials from `displayName` linking to `/me`; without a name (or signed out) a person glyph, linking to `/me` or `/signin`. |

Destinations follow the IA: search submits `q` to `/search` (soft-navigate on
submit, plain GET form without JS), categories link to `/c/{id}`, Submit to
`/submit`, bell and Inbox tab to `/me#notifications` (the Notifications card
on the dashboard), Me to `/me` (`/signin` when signed out).

## Files

| File | Responsibility |
| --- | --- |
| `global-nav.tsx` | The `GlobalNav` client component (header + tab bar), categories disclosure, avatar, search form. |
| `nav.css` | Scoped `gn-*` styles — every value reads the design tokens; the translucent material is the shared `.material-chrome` role class from `src/styles/base.css`. |
| `categories.ts` | `NavCategory` type, `DEFAULT_CATEGORIES`, `categoryHref`. |
| `notifications.ts` | `countUnread` over `GET /v1/me/notifications` rows. |
| `session.ts` | `useSignedIn` — token-store-backed sign-in state. |
| `icons.tsx` | Inline stroke icons (currentColor, 24×24, 1.5px). |
| `global-nav.test.tsx` / `categories.test.ts` | Component behaviour (rendering, menu, badge, tabs, fetch gating) and pure helpers. |
| `tsconfig.json` | See below. |

## Why there is a local `tsconfig.json`

The app tsconfig sets `jsx: preserve` for Next.js, but Vitest's esbuild
transform needs `react-jsx` to compile `.tsx` — with `preserve`, any JSX file
fails to parse (`vite:import-analysis`). The shared `vitest.config.ts` is not
ours to edit, so this directory carries a minimal nested config that extends
the app one with `jsx: react-jsx`. Vite resolves the *nearest* tsconfig, so
only `src/components/nav/**` is affected; `next build` and `tsc` keep using
the root config.

## Design rules honoured

- Token-only colour (`--ink`, `--accent`, `--rule`, `--critical` badge…),
  `--corner-control`/`--corner-card` radii, 150–200ms `--ease-decel` motion on
  transform/opacity only.
- No drop shadows — the menu is `--surface` with a 1px `--rule` border;
  translucency/blurring comes from `.material-chrome`, which also carries the
  `@supports` and `prefers-reduced-transparency` fallbacks.
- The badge always carries its number (never colour alone), caps at `99+`.
- Touch targets ≥44px (bell, avatar, tabs); `:focus-visible` rings come from
  the global base layer; `env(safe-area-inset-bottom)` pads the tab bar.
- Reduced motion, higher contrast and forced dark/light themes all flow from
  the shared token layer — nothing nav-specific to opt into.
