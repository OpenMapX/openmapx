---
title: Map comparison baseline
description: Repeatable German map, search, and place-sheet checks for cartography and discovery changes.
---

# Map comparison baseline

Use this small fixed set when changing POI visibility, map styling, search rows,
or place sheets. Compare the same camera, viewport, theme, locale, and dataset.
Keep data coverage, provider behavior, cartographic eligibility, and label
collision outcomes separate when explaining a difference.

## Reference capture: October 6, 2026

The reference is the live **OpenMapX.com** instance in a **430 × 932 CSS-pixel**
viewport, DPR 1, English, light theme, Default map, zero pitch/bearing, and no
optional overlays selected. Browser: T3 Code collaborative preview, Chromium
152.0.7977.130 / Electron 44.4.2, desktop user agent with phone-sized CSS viewport.
It contains 20 maps, four search views, and two
place sheets. The production deployment commit is unknown. Its light/dark style
file hashes match repository commit `f4229bbd81282f3fbaaf999eef61f863bcfc63aa`;
that establishes the cartography revision, not the entire deployed application.

The [machine-readable evidence](/img/map-baseline/2026-10-06/baseline.json)
records camera coordinates, rendered POI names/classes/ranks, road-label counts,
screenshots, search text, place URLs/text, enabled integration IDs, registry
revision, asset SHA-256 hashes, and public TileJSON metadata. No credentials or
private account data were inspected or recorded.

| Source           | Observed configuration / version                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Vector basemap   | Self-hosted `/tiles/data/openmapx.json`, Germany bounds; native maximum zoom 14                            |
| OSM input        | `planetiler:osm:osmosisreplicationtime=2026-10-03T20:20:50Z`, sequence 4927                                |
| Generator        | Planetiler 0.10.2, hash `0e5588c4a6e8c29a270a33afe8df62027d889604`                                         |
| Schema metadata  | OpenMapTiles version 3.16.0                                                                                |
| Glyphs / sprites | Self-hosted `/tiles/fonts`; owned `/styles/sprite`                                                         |
| Default relief   | Mapterhorn through `/api/mapterhorn/tiles.json`                                                            |
| Search           | UI credits MapTiler; chain/category suggestions also appear                                                |
| Integrations     | 104 report enabled; this does **not** establish configured keys, successful requests, or regional coverage |

`planetiler:buildtime` in TileJSON is March 28, 2026 and predates the OSM input.
Treat it as generator build metadata, not an established date for this tile
archive. An archive checksum/build date and deployment commit are unavailable
from these public responses; record them when doing an operator-controlled run.
Native zoom 14 means maps at zooms 15–18 overzoom the same dataset.

## Fixed map cases

All cases use zooms **14, 15, 16, 17, 18**. Click an image to inspect it at full
size. Monschau is a rural tourist town rather than an empty countryside fixture:
it exercises useful destinations, narrow streets, and surrounding terrain.

| Case / centre (latitude, longitude) | z14                                                        | z15                                                        | z16                                                        | z17                                                        | z18                                                        |
| ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Berlin Mitte: 52.520407, 13.404914  | [Map](/img/map-baseline/2026-10-06/berlin-z14-light.png)   | [Map](/img/map-baseline/2026-10-06/berlin-z15-light.png)   | [Map](/img/map-baseline/2026-10-06/berlin-z16-light.png)   | [Map](/img/map-baseline/2026-10-06/berlin-z17-light.png)   | [Map](/img/map-baseline/2026-10-06/berlin-z18-light.png)   |
| Aachen old town: 50.7754, 6.0839    | [Map](/img/map-baseline/2026-10-06/aachen-z14-light.png)   | [Map](/img/map-baseline/2026-10-06/aachen-z15-light.png)   | [Map](/img/map-baseline/2026-10-06/aachen-z16-light.png)   | [Map](/img/map-baseline/2026-10-06/aachen-z17-light.png)   | [Map](/img/map-baseline/2026-10-06/aachen-z18-light.png)   |
| Neuss town centre: 51.1982, 6.6916  | [Map](/img/map-baseline/2026-10-06/neuss-z14-light.png)    | [Map](/img/map-baseline/2026-10-06/neuss-z15-light.png)    | [Map](/img/map-baseline/2026-10-06/neuss-z16-light.png)    | [Map](/img/map-baseline/2026-10-06/neuss-z17-light.png)    | [Map](/img/map-baseline/2026-10-06/neuss-z18-light.png)    |
| Monschau: 50.5545, 6.2407           | [Map](/img/map-baseline/2026-10-06/monschau-z14-light.png) | [Map](/img/map-baseline/2026-10-06/monschau-z15-light.png) | [Map](/img/map-baseline/2026-10-06/monschau-z16-light.png) | [Map](/img/map-baseline/2026-10-06/monschau-z17-light.png) | [Map](/img/map-baseline/2026-10-06/monschau-z18-light.png) |

Counts below are deduplicated `queryRenderedFeatures` results from `poi-level-1`,
`poi-level-2`, `poi-level-3`, `poi-landmark`, and `poi-railway`, keyed by feature
ID, falling back to serialized name/class/geometry when no ID exists. Business
classes
are restaurant, cafe, bar, beer, bakery, ice_cream, fast_food, shop, grocery,
clothing_store, and alcohol_shop. A count includes canvas features behind UI
panels and partly clipped at the viewport edge; it is **not** a count of fully
readable labels or an independent ground-truth recall score. Review the images
as well. The geographic footprint shrinks with zoom, so these counts should
not increase monotonically.

| Case     | All POIs at z14 / 15 / 16 / 17 / 18 | Business POIs at z14 / 15 / 16 / 17 / 18 |
| -------- | ----------------------------------- | ---------------------------------------- |
| Berlin   | 10 / 11 / 8 / 18 / 9                | 0 / 0 / 5 / 11 / 7                       |
| Aachen   | 7 / 3 / 7 / 15 / 12                 | 0 / 0 / 2 / 6 / 8                        |
| Neuss    | 4 / 5 / 11 / 8 / 16                 | 0 / 0 / 5 / 4 / 13                       |
| Monschau | 5 / 5 / 13 / 17 / 10                | 0 / 0 / 5 / 10 / 5                       |

At zooms 14–15 the initial policy excludes ordinary businesses. At zoom 15,
Berlin shows Berlin Cathedral, Berlin Dungeon and Hackescher Markt; Aachen
keeps Aachen Cathedral; Monschau shows Burg Monschau and Haller. Businesses
appear at closer zooms. This is an eligibility decision, not evidence that the
dataset lacks restaurants or shops.

## Search and place cases

Search from each fixed centre at zoom 15, without moving the map. Record the
complete visible suggestion order and provider credits before selecting a row.
These observations capture current behavior; they are not desired rankings.

| Query / centre               | Reference observation                                                                                 | Evidence                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Hauptbahnhof Berlin / Berlin | Berlin area first, then Hauptbahnhof at Europaplatz; another Hauptbahnhof at Wuhlheide also appears   | [Search](/img/map-baseline/2026-10-06/search-berlin-1.png)   |
| REWE / Berlin                | Two local places, a chain suggestion, a distant place, and category matches                           | [Search](/img/map-baseline/2026-10-06/search-berlin-2.png)   |
| Aachen Dom / Aachen          | Domschatzkammer first, then Domsingschule and nearby businesses; cathedral absent from displayed rows | [Search](/img/map-baseline/2026-10-06/search-aachen-3.png)   |
| Café / Monschau              | Category rows and local cafes, plus chain suggestions and a distant airport                           | [Search](/img/map-baseline/2026-10-06/search-monschau-4.png) |

Open Aachen Cathedral by tapping its basemap symbol at zoom 17. The
[landmark sheet](/img/map-baseline/2026-10-06/place-aachen-cathedral.png) includes
a credited Wikimedia photo, address, phone, website, Wikipedia summary,
foundation/architect facts, and accessibility information. Search Schloss-Café
from Monschau, then select the Stadtstraße 4–6 result. The
[business sheet](/img/map-baseline/2026-10-06/place-monschau-cafe.png) has address,
phone, website, menu/order actions and outdoor seating, without a visible photo.
Their different entry paths and content availability are intentional fixture
coverage. Exact place deep links are in the evidence JSON.

Place screenshots show the initial half-height sheet, without manual expansion
or scrolling. The evidence text also includes rendered DOM content below the
screenshot fold; the listed facts are available sheet content, not all visible
at once. Repeat the initial sheet state before comparing layout.

For offline search-ranking regressions, use the existing
`packages/core/src/utils/__tests__/search-eval` fixtures and
`pnpm search-eval:record`; this visual baseline complements that suite.

## Repeat and assess a change

1. Record the tested Git SHA and deployment SHA, date, browser version,
   viewport/DPR, locale, theme, map mode, pitch/bearing and selected overlays.
   Record vector/glyph/terrain URLs, provider settings, non-secret credential
   availability, archive checksum/OSM snapshot, and enabled integrations.
2. Open `/?map=LAT,LON,ZOOM,0,0` for each case. Clear search and close panels.
   Wait for MapLibre `idle`, verify style and tiles are loaded, then allow label
   fades to settle before capturing. A ready check immediately after a camera
   jump can describe the **previous** frame; discard blank/loading captures.
3. Save one image per case/zoom with a new dated directory and evidence JSON.
   Keep the reference immutable. Compare current and changed styles against
   the same source tile URLs; a live dataset update invalidates a strict A/B.
4. Repeat the four searches and two place entry paths. Record missing provider
   credentials, failed requests, absent photos and incomplete coverage separately.
5. For cartography changes also repeat z14–15 in dark theme and a fixed desktop
   viewport. Assess readable business names, road-name retention, landmark and
   station prominence, overlapping symbols, clipped names, and duplicate labels.
   Check z16–18 for unintended changes and unnamed/non-ground-level points for leakage.

For the early-POI experiment, success means a restrained selection of named
businesses is discoverable at neighborhood zooms, landmarks remain prominent,
and the map remains readable. More candidates alone is not success. Tile ranks
are local ordering signals, not popularity, review quality, or global fame.
Do not infer missing places from a collision-hidden label.

The reference is a visual/discovery baseline, not a performance benchmark,
complete German coverage audit, or device certification. Pair performance work
with [navigation performance measurement](./navigation-performance.md).

## Neighborhood POI follow-up

The first change against this baseline introduces named, ground-level food
destinations and shops at z14–15. The maximum **local tile rank** is 8 / 24 for
restaurant, cafe, bar, beer, bakery and ice_cream, and 4 / 12 for shop, grocery,
clothing_store and alcohol_shop. Parking is a separate policy group with its
original later introduction. These values do not claim popularity or fame.

`poi-neighborhood-business` occupies z14 up to, but excluding, z16. It draws
below the existing POI and road-name layers so their labels claim space first.
The regular POI layers exclude these businesses below z16 to avoid duplicates;
their original close-up progression resumes at z16. Unnamed, empty-name,
non-ground-level and unranked candidates are excluded at neighborhood zooms. All symbols
keep collision avoidance enabled.

The [follow-up evidence](/img/neighborhood-pois/2026-10-06/comparison.json)
includes 20 light maps, eight dark maps, desktop light/dark comparisons and a
tap-to-place check. The candidate was applied **temporarily in the browser** on
OpenMapX.com: generated POI filters and the new layer, with the application's
existing name localization. The live instance was not deployed or changed.
Public TileJSON still reported the same October 3 OSM snapshot/schema; the
archive checksum and deployed application SHA remain unknown. These captures
isolate the style change against the same live instance and source URLs.

| Case     | Business POIs z14: before → after | Business POIs z15: before → after |
| -------- | --------------------------------- | --------------------------------- |
| Berlin   | 0 → 1                             | 0 → 7                             |
| Aachen   | 0 → 1                             | 0 → 4                             |
| Neuss    | 0 → 6                             | 0 → 5                             |
| Monschau | 0 → 2                             | 0 → 1                             |

Every baseline POI remained in the 20 light views, road-label counts were
unchanged, and z16–18 POI results were unchanged. Dark views matched the light
POI counts. The lower priority matters: an initial trial in the ordinary POI
layers displaced three smaller Berlin cultural labels; the final layer avoids
that in these fixtures. This is observed fixture coverage, not a guarantee for
every provider or city. Source rank alone also cannot promise that the most
useful restaurant or café is the one labeled in each neighborhood.

| Berlin z15 before                                            | Berlin z15 after                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| ![Before](/img/map-baseline/2026-10-06/berlin-z15-light.png) | ![After](/img/neighborhood-pois/2026-10-06/berlin-z15-light-after.png) |

| Dark before                                                                  | Dark after                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ![Before dark](/img/neighborhood-pois/2026-10-06/berlin-z15-dark-before.png) | ![After dark](/img/neighborhood-pois/2026-10-06/berlin-z15-dark-after.png) |

Maintain the policy in `apps/web/scripts/poi-visibility-policy.mjs` and its layer
generation in `apps/web/scripts/apply-poi-visibility.mjs`; run
`pnpm -C apps/web style:poi` to regenerate both owned styles. Do not edit just
one generated style. `scripts/__tests__/poi-visibility.test.ts` uses MapLibre's
installed expression engine against both generated styles to check eligibility,
rank boundaries, exclusions, duplicate prevention, layer priority, and validity.
Repeat generation to check idempotence and repeat the visual matrix before
expanding the thresholds. Hosted complete MapTiler styles are outside this
owned-style policy.

For versioned search, identity, enrichment and navigation evidence alongside these
visual cases, follow [Discovery evaluation](discovery-evaluation.md). Store new
capture archives externally with a manifest and checksums; attach selected review
images directly to the PR.

## Regional ambient-place acceptance (#399)

The October 8–9 acceptance run repeats the four fixed cameras at zooms 14–18
against the same public basemap TileJSON and the same policy-2 regional publication.
Neuss lies inside the published Rhine bbox; Berlin, Aachen and Monschau are
outside-region controls. Cologne and a rural Rhine camera add dense/sparse
positive cases. This is a disposable real OSM extract, not a production deployment
or a recall audit of all German places.

Source eligibility and rendered labels remain separate: Quirinus-Münster has
corroborated source-backed zoom-14 eligibility, while retained city/road labels can
still win a particular collision. The fixed zoom-16 Neuss view gains its name with
collision-safe landmark anchors. Ordinary labels keep one position. All 45 paired views compare source/source-layer/feature-ID, rendered-layer,
coordinate/name identities as well as road-name lists. Known owned
basemap identities and selected/category destinations suppress their ambient
counterpart; distinct source IDs are not guessed to be the same business merely
because their names are similar.

See [regional publication and measured budgets](ambient-places-publication.md)
and its aggregate JSON for source hashes, fixed settings, camera outcomes,
read/fallback/rollback evidence and desktop/Safari simulator frame samples.
The October 9 cartographic correction borrows the active basemap's POI badges,
category colors, typography and halos, replacing the separate teal dot/label
renderer. Ordinary names sit below their badges; landmark names use compact
wrapping and may remain when only the badge collides. Icons and text retain
normal collision checks. The new matrix, runtime and screenshots are recorded
separately under `visualCartographyFollowup` in the aggregate artifact.
Before/after screenshots are PR attachments outside git. Simulated Safari results
must not be presented as physical-device battery, thermal or fleet certification.
