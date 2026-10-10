# Ambient place acceptance follow-up (#399 / PR #436)

## Intent and boundaries

Complete the remaining bounded-region acceptance work: source-backed regional
landmarks, actual regional QA, declared performance limits and resilient duplicate
suppression during theme/style changes. Work inline in the existing isolated
worktree; update PR #436 without approvals, merge or deployment. Preserve all
other checkouts. OpenConditions, adapters, feeds, mobility, planet/direct ATP
imports, geocoder redesign and offline delivery remain outside scope.

## Source-backed prominence

The existing search extractor produces slash categories such as
`amenity/hospital`; ambient policy must normalize both those and colon aliases.
Exercise extractor output directly so synthetic rows cannot hide this mismatch.
Policy version 2 retains the existing ID/tile contract and publication budgets.
Essential categories retain zoom 13, ordinary business categories zoom 15, other
places zoom 16 and non-ground tenants zoom 18.

A cultural destination (place of worship, museum, castle, monument,
archaeological site or tourist attraction) gets regional landmark priority only
with two auditable signals: a valid Wikidata ID or language-prefixed Wikipedia
reference, plus positive heritage registration or a cathedral/basilica (`yes`, `minor`, `major`) designation.
Reject `heritage=no`, malformed identities and generic names as evidence. Heritage
levels 1–3 or cathedral/basilica designation start at zoom 14; other registered
heritage destinations start at zoom 15. Rank them above ordinary businesses and
below essential services. Closure/private access and tenant deferral always win. A corroborated, explicitly
mapped whole cultural building footprint (way/relation, not indoor/building-part)
is a building destination rather than an interior tenant; its level metadata
does not assert an entrance or defer the entire cathedral. Indoor/part/node
records remain conservatively deferred.
No named-building exceptions, popularity scores or worldwide church revelation.
Quirinus-Münster and Cologne Cathedral are source-backed corpus examples; ordinary
nearby worship buildings, malformed/no evidence, closure and tenants are controls.
Preserve supplied German/English labels and exact source IDs.

## Style lifecycle

The overlay must reinstall its current per-layer suppression filter when its
owned layer descriptor is recreated by a paint-only theme change, even if the
subsequent complete basemap fetch fails. Also repair a lost filter on idle without
unbounded repeated writes. Use the current map filter or layer identity, scoped
per map; retain existing cleanup and normal full-style reload behavior. A theme
regression must exercise the real group hook/recreation semantics.

## Real data and reproducibility

Use public metadata-stripped, dated Geofabrik regional PBFs, crop to one Rhine
bbox [6.58,50.89,7.07,51.31], then run the existing OSM extractor/index builder
into a disposable PostGIS instance. Record source URLs, snapshot dates, SHA-256,
crop bounds, tool/runtime versions, extraction and publication counts/times,
generation and policy version. No production database writes. OSM-only coverage
is explicit; existing tests cover optional Overture/conflated identities.

Repeat fixed #393 cameras at zooms 14–18 with the same basemap source, candidate
publication and settings. Neuss and Cologne supply positive real regional scenes;
Berlin/Aachen/Monschau remain controls outside this publication. Add a rural Rhine
scene. Separate source eligibility, rendered labels, identity matching and label
collisions. Capture light/dark, locale, pan/zoom, owned basemap style replacement,
provider-disabled/no-region behavior and canonical tile/basemap place-card taps.
Screenshots and raw public source data stay outside the repository. Commit a small
source-backed policy corpus and machine-readable aggregate evidence with checksums;
attach selected real before/after and mobile evidence to the existing PR.

## Declared acceptance budgets

Apply unchanged 100,000 input/output, 256-feature, 128-KiB, zoom 13–18, 2-second
SQL and eight-pending-request hard guards. For this local regional pilot:
- Full regional publication completes within 60 seconds after indexing.
- Sparse/dense tile repository reads: warm p95 <=100 ms (at least 30 samples);
  eight-concurrent p95 <=250 ms; first request <=1000 ms.
- Zero retained explicit-identity duplicates or incorrect landmark taps.
- Road/transit labels in fixed before/after views must not lose priority.
- Five foreground 5-second pan/zoom runs per overlay state, after tile settling:
  p95 animation-frame interval <=33.4 ms, <=5% intervals >50 ms; report off/on
  samples, viewport, DPR, browser/device, thermal/load limits and errors.
Measure production assets in desktop and phone CSS viewports, plus Safari on the
available iOS simulator. Simulator results do not certify physical-device battery,
thermal behavior or all mobile hardware; disclose that remaining deployment limit.
If a target fails, diagnose and fix the feature, then repeat the affected checks;
do not retroactively loosen thresholds to claim success.

## Admin, docs and delivery

Show publication policy version in existing admin metadata. Update current
ambient publication and comparison documentation with ranking evidence, real
source coverage, reproducible commands, target/result tables and deployment limits.
Run focused and real PostGIS tests, lint/types/full tests and affected production
builds. One fresh strongest-model review checks the follow-up plus full branch;
fix important findings in one test-backed pass. Push through temporary HTTPS
credentials, refresh PR evidence/body, verify assignee/labels/attachments, T3 link
and hand back with accurate completion evidence. No merge or deployment.
