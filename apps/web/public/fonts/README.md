# Self-hosted fonts

Vendored latin subsets so Scholium renders its typography without a
third-party request at runtime. Files originate from Google Fonts and are
variable fonts (one file per face, weights listed below).

| File | Family | Axes | Source |
| --- | --- | --- | --- |
| `source-serif-4-latin.woff2` | Source Serif 4 | `wght 200–900`, `opsz 8–60` | https://fonts.google.com/specimen/Source+Serif+4 |
| `source-serif-4-italic-latin.woff2` | Source Serif 4 Italic | `wght 200–900`, `opsz 8–60` | https://fonts.google.com/specimen/Source+Serif+4 |
| `inter-latin.woff2` | Inter | `wght 100–900` | https://fonts.google.com/specimen/Inter |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | `wght 100–800` | https://fonts.google.com/specimen/JetBrains+Mono |

All three families are licensed under the SIL Open Font License 1.1; the full
license text ships beside the binaries in [`OFL.txt`](./OFL.txt).

- Source Serif 4 — © 2021 The Source Serif Project Authors
- Inter — © 2016 The Inter Project Authors
- JetBrains Mono — © 2020 The JetBrains Mono Project Authors

`unicode-range` in `src/styles/fonts.css` restricts each face to the latin subset;
other scripts fall through to the system stacks in `../theme.css`.
