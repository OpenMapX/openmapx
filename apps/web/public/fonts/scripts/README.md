# Bundled script fallback fonts

WOFF2 font subsets loaded lazily through MapLibre's root `font-faces` style
property (`apps/web/src/lib/scriptFontFaces.ts`). They cover the six Unicode
scripts that are missing (0 glyphs inside HTTP 200 range files) from both
OpenFreeMap's `Noto Sans` glyph endpoint and `openmaptiles/fonts v2.0`, where
MapLibre would otherwise draw blank labels instead of falling back to system
fonts.

Each file is retrieved from Google Fonts' Noto Sans WOFF2 distribution on
21 November 2026 and remains under its upstream **SIL Open Font License 1.1**
(`OFL-1.1`), not OpenMapX's AGPL code license. The license notice is also
included on the `/licenses` page via `apps/web/scripts/generate-license-notices.mjs`.

| File                                       | Version | Script                        | MapLibre `unicode-range`                      | Upstream project                                 |
| ------------------------------------------ | ------- | ----------------------------- | --------------------------------------------- | ------------------------------------------------ |
| `NotoSansTifinagh-Regular.woff2`           | `2.006` | Tifinagh (Berber)             | `U+2D30-2D7F`                                 | https://github.com/notofonts/tifinagh            |
| `NotoSansThaana-Regular.woff2`             | `3.001` | Thaana (Dhivehi)              | `U+0780-07B1`                                 | https://github.com/notofonts/thaana              |
| `NotoSansCanadianAboriginal-Regular.woff2` | `2.004` | Canadian Aboriginal Syllabics | `U+1400-167F`, `U+18B0-18F5`, `U+11AB0-11ABF` | https://github.com/notofonts/canadian-aboriginal |
| `NotoSansNewTaiLue-Regular.woff2`          | `2.004` | New Tai Lue                   | `U+1980-19DF`                                 | https://github.com/notofonts/new-tai-lue         |
| `NotoSansCherokee-Regular.woff2`           | `2.001` | Cherokee                      | `U+13A0-13FF`, `U+AB70-ABBF`                  | https://github.com/notofonts/cherokee            |
| `NotoSansOlChiki-Regular.woff2`            | `2.003` | Ol Chiki (Santali)            | `U+1C50-1C7F`                                 | https://github.com/notofonts/ol-chiki            |
