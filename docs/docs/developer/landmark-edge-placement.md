---
title: Landmark edge placement evaluation
description: The bounded issue 431 experiment, source and renderer diagnosis, and no-ship decision.
---

# Landmark edge placement evaluation

**Decision: retain the current landmark placement.** The bounded experiment for
[#431](https://github.com/OpenMapX/openmapx/issues/431) reproduced Berlin
Cathedral's clipping without moving the original camera. Top-first variable
anchors, including explicit per-anchor offsets, did not improve target
readability at any tested edge. Narrower wrapping helped the original English
case but did not resolve the edge probes and changed surrounding collisions.
A fixed directional anchor helped one side while retaining failures elsewhere
and abandoning the preferred default placement. These results do not justify a
production style change.

This is a placement experiment for already eligible landmarks. Regional
prominence and source eligibility remain the separate question in #399.
The generator, generated styles and admin panel are unchanged.

## Frozen reproduction and separate control

The read-only OpenMapX.com reproduction on October 7, 2026 used dark theme,
English, the Default self-hosted OpenMapTiles basemap, zoom 15, pitch/bearing 0,
430 × 932 CSS pixels and DPR 1. Preserve centre **[13.404914, 52.520407]**
(longitude, latitude). The observed map padding was top 112, bottom 34, left/right
0 pixels; this matters when reproducing the projection.

`Berliner Dom`, feature ID `3136707342`, rank 18, class `place_of_worship`, is
present in source features and returned by `queryRenderedFeatures` in
`poi-landmark`. Its source point is **[13.40109407901764, 52.51908368961429]**,
projecting to approximately **[36.98, 606.35]** in the original canvas. The
English text `Berlin Cathedral` is clipped at the left edge. A returned rendered
feature therefore does not establish that its text is fully readable.

The separately labelled **centered control** centres on the source point using
the same theme, viewport, zoom and padding. Its label is readable without a
style change. This control is additional evidence, never a replacement for the
frozen original-camera screenshot.

The deployed reproduction used T3 Code's Chromium 152.0.7977.130 / Electron
44.4.2 preview. After that preview became unavailable, the completed local
comparisons used headless Chrome 154.0.8037.93 on macOS, DPR 1, and the installed
MapLibre GL JS **6.10.0**. The local browser allowed SwiftShader; the actual GPU
backend was not independently identified. These are phone-sized desktop browser
canvases, not a real-device rendering certification.

## Revisions and data

The isolated worktree started from freshly fetched main
`3c80939d26a09f131b16d849895255436b5e5798`. Local comparisons used its owned
styles, public self-hosted glyphs/sprites and cached public vector responses.
Within each A/B group all inputs except the stated landmark layout property
were held constant. Language expressions use the repository's
`localizeTextField` helper, preserving road references and elevation expressions.
An earlier simplified localization run was discarded and the complete matrix
recaptured with that helper.

The deployed and main `poi-landmark` layers match in both themes. Surrounding
layers differ: main includes `poi-neighborhood-business` and revised ordinary
POI filters. Consequently the local main A/B is matched internally, but is not
a pixel comparison against the deployed application. Local captures contain
the map, case tag and attribution rather than the application's search/footer
controls. Relief and optional application overlays are absent in every local
variant. Canvas containment does not measure labels hidden behind application UI.

| Input                        | Observed value                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Vector source                | `https://openmapx.com/tiles/data/openmapx.json`; Germany bounds; native maximum zoom 14, overzoomed at 15 |
| OSM replication              | `2026-10-03T20:20:50Z`, sequence 4927                                                                     |
| Generator                    | Planetiler 0.10.2, `0e5588c4a6e8c29a270a33afe8df62027d889604`                                             |
| Schema metadata              | OpenMapTiles 3.16.0                                                                                       |
| Deployed dark style SHA-256  | `62786c49fb9fea3455410135730b42fa0c0cc4ce580864cf168a805e3d33211a`                                        |
| Deployed light style SHA-256 | `d0c548b10cb19054b32324f8f225db67aaaefdc7bc7e2934d7e6e06f44ca0469`                                        |
| Main dark style SHA-256      | `f24217e849e4256c7ced9749b1cdc0ed6feb0bd3d0e0a249ef43e66bff8acf22`                                        |
| Main light style SHA-256     | `4103b56380c9f700cdc320f48fbb9fb7b716fa5006339af80818c9761971826d`                                        |

Deployment commit, tile archive checksum and archive creation date are unknown.
TileJSON's March 28 `planetiler:buildtime` predates the OSM replication timestamp;
it is generator build metadata, not an established extract date. The evidence
bundle records SHA-256 hashes of the public responses actually used. Those
response hashes do not identify the complete tile archive.

## Candidates and coverage

The existing generator uses `text-anchor: "top"`, `text-offset: [0, 1.3]`,
`text-max-width: 9`, Noto Sans Bold and approximately 13-pixel text at zoom 15.
The landmark layer claims placement space before major road names and ordinary
POIs. All candidates retained eligibility, rank, layer order, font,
size, icon policy, collision flags and label budgets.

| Variant                | Temporary landmark-only layout change                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed                  | Unchanged current placement                                                                                                                                                             |
| Variable               | Add `text-variable-anchor: ["top", "top-left", "top-right", "bottom", "bottom-left", "bottom-right", "left", "right"]`; retain `[0, 1.3]`                                               |
| Explicit offsets       | Remove `text-offset`; set `text-variable-anchor-offset: ["top", [0, 1.3], "top-left", [1.3, 1.3], "top-right", [-1.3, 1.3], "bottom", [0, -1.3], "left", [1.3, 0], "right", [-1.3, 0]]` |
| Directional diagnostic | Fixed `top-left`, offset `[1.3, 1.3]`; deliberately tests the directional tradeoff, not a candidate preserving the default                                                              |
| Compact                | Retain anchor/offset; reduce `text-max-width` from 9 to 6                                                                                                                               |

The completed matrix contains **480 settled cases**: two scenes × two viewports
× four edges × five variants × six theme/language combinations. Dark uses
English, German, French, Russian and Japanese; light uses English. This includes
Latin, Cyrillic and Japanese text, short `Berliner Dom` and longer translated
cathedral/castle labels. Every case uses zoom 15, pitch/bearing 0 and DPR 1.

- Dense scene: Berlin Cathedral at the source point above.
- Sparse/regional scene: Neuschwanstein Castle, ID `2216019692`, rank 8,
  point `[10.749698281288147, 47.55755219970797]`.
- Viewports: 430 × 932 and 1280 × 800 CSS pixels.
- Edge probes: place the target point 25 pixels inside each edge, with the
  orthogonal coordinate at the canvas midpoint. Exact computed cameras are in
  the matrix. These are additional cases, not modifications of the original.

Monschau was inspected during fixture selection: Burg Monschau is source-present
and rendered as an ordinary POI but lacks the translations required for the
current landmark filter. Using it as the sole sparse landmark test would not
exercise this layer. No eligibility changes were made to manufacture a fixture.

Before accepting a style change, require a demonstrated edge readability gain
with the preferred default retained, without material collision/hierarchy or
panning regressions. A higher aggregate feature count alone is insufficient.

## Measurements and visual findings

Source presence, query-rendered presence and complete text containment were
recorded separately. The aggregate includes point POI symbols with both text
and icon collision boxes, using the first inserted box (text). It excludes
text-only and icon-only symbols. The probe subtracts the settled renderer's
100-pixel grid padding, deduplicates layer/feature IDs, and checks whether the
whole padded text box is inside the canvas. This is a conservative geometric proxy for
complete text, not an independent useful-label recall score. The cathedral and
castle are the two independently specified useful targets; surrounding labels
were inspected for readable context and hierarchy.

Every variant had its target source-present and query-rendered in all 96 cases.
The table counts **complete target text boxes** out of 24 cases per edge. Total
point-POI text-box observations sum repeated scenes and do not represent unique
places or a semantic recall score.

| Variant                | Left  | Right | Top   | Bottom | Complete / clipped point POI text observations |
| ---------------------- | ----- | ----- | ----- | ------ | ---------------------------------------------- |
| Fixed                  | 0/24  | 0/24  | 24/24 | 0/24   | 1,235 / 419                                    |
| Variable               | 0/24  | 0/24  | 24/24 | 0/24   | 1,238 / 415                                    |
| Explicit offsets       | 0/24  | 0/24  | 24/24 | 0/24   | 1,250 / 413                                    |
| Directional diagnostic | 24/24 | 0/24  | 24/24 | 0/24   | 1,282 / 431                                    |
| Compact                | 0/24  | 0/24  | 24/24 | 0/24   | 1,246 / 432                                    |

Variable anchors added one complete point label in 15 matched cases, lost two
in six and left 75 unchanged. Explicit offsets improved 22 cases, worsened six
and left 68 unchanged. Neither improved the specified useful target at an edge.
Compact wrapping improved 13 cases, worsened three and left 80 unchanged;
rendered road-name observations decreased in 22 cases. These road observations
are non-deduplicated query results, not a count of readable road labels. They flag
collision substitutions for visual review rather than prove a semantic loss.
All cases passed load/error checks and target-position validation. One initial
case after a browser resize used the old canvas dimensions; it was discarded
and recaptured after explicit map resizing.

The original-camera local comparisons agree in light and dark:

| Variant                | Cathedral complete | Complete / clipped point POI text boxes | Rendered road-name feature observations |
| ---------------------- | ------------------ | --------------------------------------- | --------------------------------------- |
| Fixed                  | No                 | 11 / 8                                  | 19                                      |
| Variable               | No                 | 11 / 8                                  | 19                                      |
| Explicit offsets       | No                 | 11 / 9                                  | 19                                      |
| Directional diagnostic | Yes                | 12 / 8                                  | 19                                      |
| Compact                | Yes                | 12 / 7                                  | 18                                      |

The fixed cathedral text box spans x **−18.15 to 92.10** pixels. Variable
placement leaves that horizontal extent unchanged, with a roughly 1.9-pixel
vertical shift despite retaining `top` first. Compact wrapping brings the
English original-camera box inside the canvas, but increases its height and
changes a road-name collision observation. At 25-pixel side margins it remains
clipped; longer translations do not establish a general solution. Directional
placement improves the left side but is still clipped at the right and bottom.

Full-resolution matched comparisons were personally inspected for the original
camera in both themes, all four edges of both scenes at both widths, and French,
Russian and Japanese Berlin left-edge labels. Landmarks remain visually stronger
than ordinary POIs. No new obvious text overlaps appeared in those captures;
the measured point-POI text-box overlap check also found none. This does not
certify line-label, icon/text, UI-overlay or all possible map collisions.
Dense scenes show surrounding label substitutions; sparse scenes still clip
the target, so collision pressure alone does not explain the edge failure.

Panning covers 24 runs: two scenes × two widths × English/Russian × fixed,
variable and compact. Each run animates through 11 horizontal positions from
left to right and back, settling at each stop (**264 samples**). Target
query-rendered visibility and text-box offset relative to its point are recorded.
Across all three variants, the settled target had zero query-rendered visibility
transitions and zero relative text-box offset jumps over 3 pixels; maximum offset
variation rounded to 0.00 pixels. The targets stayed rendered while becoming
clipped near the sides. The stop sequence retained its recorded vertical
projection (505 pixels on phone, 439 on desktop); it is a separate horizontal
pan control, not the midpoint edge-probe camera.

Six additional full-resolution phone/English videos sample the two scenes and
three variants during motion. Their inspected frames show the text travelling
through the edge rather than an automatic inward anchor switch. Settled samples
and selected motion frames are not a continuous-frame flicker guarantee;
explicit-offset and directional variants were not included in this pan matrix.

## Why variable anchors did not fix the edge

[MapLibre's variable-anchor specification](https://maplibre.org/maplibre-style-spec/layers/#text-variable-anchor)
describes ordered alternatives for collision placement. In the pinned renderer,
[collision placement](https://github.com/maplibre/maplibre-gl-js/blob/v6.10.0/src/symbol/collision_index.ts)
uses a grid extending 100 pixels beyond the viewport to support stable panning.
Its bounds test accepts a box intersecting that grid; it does not require the
whole text rectangle to lie inside the visible canvas.
[Variable placement](https://github.com/maplibre/maplibre-gl-js/blob/v6.10.0/src/symbol/placement.ts)
tries the previous anchor first when available and otherwise takes the first
placeable alternative. A collision-free preferred anchor can therefore be
accepted while its text crosses the viewport edge. This implementation explains
the observed unchanged side clipping; it is not evidence that alternative
anchors can never help a different collision case.

An edge-aware renderer or placement policy could be investigated separately,
but would need to weigh readable edge labels against panning stability and
placement priority. This experiment does not justify changing renderer internals
or applying screen-position-specific layout updates to production.

## Evidence and verification

- [Measurements, phone captures and motion clips](https://github.com/user-attachments/files/33178191/431-measurements-phone-motion.zip),
  SHA-256 `34d53a34dc747b8e789667db6040d742d91b628bccf3ead7004f3a036c678ca2`.
- [Desktop captures](https://github.com/user-attachments/files/33178190/431-desktop-screens.zip),
  SHA-256 `400a86bbdbc1dc703324377671d9ad3440bea9d1f23d650305d702ce07390333`.
- Selected comparison images are attached to the PR linked from
  [issue #431](https://github.com/OpenMapX/openmapx/issues/431).

Review images are attached to the issue's PR, outside Git. The evidence bundle
contains the complete matrix, original/control measurements, panning samples,
public-source metadata and response hashes, plus the temporary harness and
capture scripts. Public data can change on replay; exact archive bytes were not
published. Screenshots retain OpenStreetMap/OpenMapTiles attribution.

- `pnpm install --frozen-lockfile`: passed.
- `pnpm lint`: passed with existing warnings; translation check had zero errors.
- `pnpm check-types`: passed; 30 Turbo tasks were cache hits, plus the discovery
  evaluation TypeScript check.
- `pnpm -C apps/web style:poi`: regenerated both owned styles with no diff.
- POI generator and hover placement regression suites: 32 tests passed.
- `pnpm test`: **failed**, 1,610 files / 17,700 tests passed; eight files failed,
  nine tests failed, 30 files / 220 tests skipped. Failures were test/import-hook
  timeouts and consequent teardown errors on unchanged main source.
- Reduced-concurrency reruns passed all nine previously failing individual tests
  (five files, 161 tests), the places suite (63 tests), and admin ops authority
  (three tests). The core-routes suite still timed out in its 10-second import
  hook when run alone; its 13 tests remain unverified locally. This is a stated
  limitation, not a claim that the full suite passes.
- `pnpm -C docs typecheck` and `pnpm -C docs build`: passed.

The delivered change records the evaluation and updates the existing cartography
baseline. It ships no placement behaviour and makes no deployment change.
