---
title: Berlin business name/address retrieval investigation
description: Evidence and a bounded lexical-search recommendation for issue 430, without production search or ingestion changes.
---

# Berlin business name/address retrieval: go/no-go

**Decision, 2026-10-07:** GO for a small, local lexical candidate follow-up using
existing Overture Places, after inspecting the intended deployed generation.
NO-GO for production adoption on this evidence alone. There is no demonstrated
need for a new source pipeline: the inspected Overture release already contains
the independently verified EDEKA Moch tenant. No production code, data, cache,
configuration, ingestion or deployment changed in this investigation.

The immediate failure is reproducible for the operator-specific name:
`EDEKA Moch` retrieves fuzzy namesakes, and `EDEKA Moch Grunerstraße 20` retrieves
addresses without a business. Shorter EDEKA queries retrieve a mall POI with a
different inferred address and incomplete identity. That is a separate outcome:
**a different returned address does not prove a different real-world branch**.
Ranking cannot recover a missing named candidate; conversely, branch rows lost
after retrieval must not be scored as upstream omissions.

## Evidence and reproducibility

The [versioned evidence directory](https://github.com/OpenMapX/openmapx/tree/main/scripts/discovery-eval/business-name-address)
contains 13 queries, selected raw/provider and adapted fields, source records,
request metadata/hashes, the historical combination/ranking/Enter replay,
independently observed live UI lists and offline checks. Its README provides
recapture parameters and commands. Full raw captures and screenshots stay outside
Git in `/tmp/openmapx-430`; this temporary local archive has no durable public URL.
Committed selected fixtures support review without access to that archive.

This extends the [discovery evaluation protocol](discovery-evaluation.md) and
the [#424 live pilot](https://github.com/OpenMapX/openmapx/pull/424#issuecomment-6045066881).
Unlike the pilot's approximate label/radius assessment, exact business recall
here requires an independently verified branch identity. A same-brand row within
200m is insufficient. Expectations were frozen before comparison; there is no
before/after production feature comparison or application-only causal claim.
The initial 12 queries were captured together; the independently verified Schaaf
control was added before capturing that additional query. Alexanderstraße's
initial target judgment was corrected to **unresolved**, with no exact-entity
denominator, after inspecting its source reference.

| Condition                    | Pinned value or specific limitation                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source inspection and replay | Freshly fetched main `3c80939d26a09f131b16d849895255436b5e5798`; task-owned worktree/branch. Source files unchanged; evaluation additions made the worktree dirty during replay.                                                                                                                                                               |
| Concurrent fixes             | #428/#429 issue bodies/comments read; no fixes/cherry-picks included. Historical replay is tied to this baseline. The current replay command prints its own revision and must not be compared as if unchanged.                                                                                                                                 |
| Public API/UI deployment     | Unknown SHA; public responses do not identify it. Local HEAD does not identify the remote app.                                                                                                                                                                                                                                                 |
| Query context                | English, center `[13.416,52.5194]`, zoom 15. Raw MapTiler uses the adapter's rounded proximity `[13.42,52.52]`; autocomplete `limit=6`, `autocomplete=true`, explicit types including POI; aggregate limit 8. All 13 queries have one synonym variant.                                                                                         |
| Raw provider                 | MapTiler, operator-owned local API credential; credentials omitted from capture parameters and fixtures. Geocoder dataset/index generation unavailable.                                                                                                                                                                                        |
| Public providers             | `/api/integrations` listed MapTiler, Photon, Nominatim, Pelias, MOTIS, DB RIS, Entur, OSM aliases and notable places as enabled. Response rows identify `geocoding-maptiler`. This does not establish the configured chain order, service availability, database contents or capability bindings. `poi-overture` was not listed.               |
| Deployed OSM/Overture        | Unknown extract/fingerprint, active generation, index epoch and publication state. Both authenticated status endpoints returned HTTP 401; admin integration navigation redirected to the public map. No deployed database was accessed.                                                                                                        |
| Inspected OSM                | Current OSM API map bbox `[13.414,52.5185,13.418,52.521]`, direct elements/history for controls, explicit IDs/versions/timestamps. This is not a regional PBF or a deployed extract. Map response SHA-256 is in `sources-v1.json`.                                                                                                             |
| Inspected Overture           | Read-only S3 Places release `2026-09-23.1`, bbox `[13.408,52.513,13.426,52.527]`, DuckDB 1.5.6, 3,255 unfiltered rows. Selected records retain GERS IDs, versions and per-property provenance. STAC discovery returned 403; the explicit release path from official documentation was readable. No asset ETags/full release checksum measured. |
| Cache                        | Uncontrolled at MapTiler/public CDN/API/browser. API source has autocomplete L1 soft 5min/hard 2h, L2 1h; forward cache 24h; aggregate 5min and partial responses uncached. No cache was flushed or bypassed. HTTP headers do not establish cold/warm state.                                                                                   |
| Live UI                      | Separate public capture, 1280×800, DPR 1, dark, fixed camera, pitch/bearing 0, anonymous session, no saved places or recents before list capture. Camera initialization attempts were discarded; retained rows have the Berlin camera. Styles were not pinned: no cartography comparison is claimed.                                           |

Source traces at the pinned revision:

- `integrations/geocoding-maptiler/provider.ts`: autocomplete maps features in
  order without filtering or sorting; `properties.ref` is not exposed as an OSM
  identity. A formatted address is provider output, not necessarily an OSM tag.
- `integrations/geocoding/{index,orchestrator,query-expansion}.ts`: round bias,
  cache, first nonempty configured provider, concatenate variants/deduplicate IDs.
- `services/data-manager/src/jobs/search-index/{terms,extract}.ts` and
  `integrations/search-osm-aliases/provider.ts`: aliases/codes/conservative acronyms
  drive exact/prefix search. Ordinary primary name/address terms are not added;
  zero-term features are skipped. The inspected EDEKA room, MediaMarkt, REWE and
  Schaaf all produce zero terms in the existing extractor.
- `integrations/poi-overture/index.ts`: category provider, confidence floor 0.5,
  permanent-closure filter and top-50 window; no business-name text candidate
  method. `poi-search/orchestrator.ts` selects the first text-capable provider.
- `packages/core/src/utils/overpass.service.ts`: full escaped query matched
  against `name` on POI nodes/ways; no name/address decomposition. The known OSM
  name `EDEKA` cannot match the whole `EDEKA Moch Grunerstraße 20` expression.
- `integrations/search-suggestions/orchestrator.ts`: provider deadline 1,200ms,
  all-settled fan-out, merge before limit. `SearchBar.tsx` concatenates aggregate
  suggestions and autocomplete, then uses `suggestionRanking.ts` and `enterAction`.

## Tenant and branch judgments

[Official EDEKA profile 408935](https://www.edeka.de/maerkte/408935/)
identifies EDEKA Moch at Grunerstr. 20, 10179 Berlin, phone `+493024045625`.
Its structured point is `[13.4147929,52.519901]`; this is a retailer listing point,
not a surveyed entrance. The [mall's own listing](https://www.alexacentre.com/en/center-info/opening-hours/)
places its EDEKA in the first basement. Do not use shared mall coordinates to
merge EDEKA with [MediaMarkt Berlin-Mitte](https://www.mediamarkt.de/de/store/berlin-mitte-190).

| Inspected source/entity         | Status and identity evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overture Moch                   | **Present, verified listing:** GERS `035b544e-40f5-4ce0-a06f-1c9032ded028`, v13, name “EDEKA Moch Supermarket”, Grunerstraße 20, same official phone. Meta record `194804870560113`, updated 2026-08-24; Overture confidence calculation updated 2026-09-17. Confidence ≈0.99991, operating status null (unknown, not closed).                                                                                                                                                                         |
| OSM exact operator name/address | **Absent in the inspected mall records:** no `Moch` name/contact or Grunerstraße address on the EDEKA element. This is a bounded attribute gap, not proof that the business is absent from all OSM.                                                                                                                                                                                                                                                                                                    |
| OSM EDEKA mall room             | **Present, operator identity unresolved:** [way 1204762785 v3](https://www.openstreetmap.org/way/1204762785/history/3), timestamp 2026-01-23, supermarket, indoor room, level -1, name EDEKA, city Berlin; no street/number/contact/operator. Mall [way 258898047 v38](https://www.openstreetmap.org/way/258898047/history/38) has Grunerstraße 20. Geometric context and basement agreement suggest the same tenant, but do not independently establish its operator or a verified cross-source link. |
| Returned Alexanderstraße 25     | Raw MapTiler `poi.39267497` explicitly references `osm:w1204762785`, coordinates `[13.4167764,52.5185536]`. The OSM way does not assert Alexanderstraße 25. Nominatim resolves that way to Alexanderstraße without a house number. Therefore **address inference/identity ambiguity**, not a verified alternative branch and not exact Moch success.                                                                                                                                                   |
| MediaMarkt control              | OSM [node 322490364 v24](https://www.openstreetmap.org/node/322490364/history/24), explicit Grunerstraße 20 and branch-specific website. Overture GERS `bfbe5e1d-7db5-482e-8772-f53959dde008` v9 and `81270f18-8f0b-48a9-ae69-31d4ef96cdd5` v8 both describe the mall branch; candidate duplicate requiring branch/website evidence, not an ID-only merge.                                                                                                                                             |
| Nearby EDEKA control            | [Official Schaaf profile 407497](https://www.edeka.de/maerkte/407497/), Schillingstr. 2, phone `+493023458611`. OSM node `9154787137` has that street/number; Overture GERS `a56cd442-edcf-4d26-98c1-9c70de50f1d7` v11 has matching name/address/phone. Raw MapTiler references that node but formats Singerstraße 121, another address discrepancy. This branch is distinct from Moch by verified name/address/contact.                                                                               |
| REWE control                    | [Official REWE profile 1350030](https://www.rewe.de/marktseite/berlin-mitte/1350030/rewe-markt-ackerstr-23-26-invalidenstr-158/) and OSM node `348000444` v29 verify Invalidenstraße 158. Its Overture status is **unknown**: outside the scanned bbox, not queried.                                                                                                                                                                                                                                   |
| Production copies               | All source-presence judgments above are **unknown in the deployed generations**. No query miss establishes an empty deployed table.                                                                                                                                                                                                                                                                                                                                                                    |

The Overture Moch record is sufficient to justify evaluating existing-data
retrieval. No ATP coverage claim is made. If a pinned deployed generation lacks
it, first compare that generation/source row and import filters to this inspected
release. If the intended source truly lacks it, a separate enrichment proposal
needs a dated retailer listing, source permissions, stable store ID and a
bounded independently judged coverage sample; do not assume ATP contains it.

## Layer comparison and quality

Each query yielded six raw MapTiler features and six public autocomplete rows,
with identical ID order across the independent captures. Offline invocation of
the actual pinned adapter preserves every feature's ID, label, formatted address,
type and coordinates. All 13 aggregate replies were empty **and partial**;
provider health/errors or deployed index availability remain unknown.
The combined place pool is therefore the six adapted rows per query, not evidence
of a successful empty local-data lookup. No synonym amplification occurred.

| Query                                     | Raw/adapted retrieval                                          | Pinned ranked places and Enter                | Live dropdown                                                          |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| EDEKA Moch                                | Moch absent; fuzzy Koch/Möck namesakes                         | Six rows; choose                              | Namesake first, no Moch                                                |
| EDEKA Moch Grunerstraße 20                | No POI; address first                                          | Six rows; weak area search                    | Address first; actual Enter → area panel, 0 results                    |
| EDEKA Grunerstraße 20 Berlin              | Unresolved `poi.39267497`, no verified Moch                    | Six rows; weak area search                    | Unresolved EDEKA first                                                 |
| EDEKA Alexa                               | Same unresolved way first                                      | Six → three rows; open unresolved ID          | Three places; actual Enter → that EDEKA sheet, Alexanderstraße address |
| EDEKA Grunerstraße                        | Same unresolved way first                                      | Six → four; weak area search                  | Four places; unresolved EDEKA first                                    |
| EDEKA Alexanderstraße 25 Berlin           | Returned-address control; identity unresolved                  | Six → four; open unresolved ID                | Same unresolved candidate first                                        |
| EDEKA                                     | Ambiguous brand; no unique branch expectation                  | Six → three; area search                      | Three places plus brand shortcut; no exact-tenant success claim        |
| MediaMarkt Alexa                          | Verified Berlin branch raw rank 2; Rijswijk first              | Berlin remains rank 2; open Rijswijk          | Rijswijk first, Berlin second: #428 ranking defect                     |
| MediaMarkt Grunerstraße 20 Berlin         | Verified branch rank 1                                         | Rank 1; open Berlin                           | Berlin first                                                           |
| REWE Invalidenstraße 158 Berlin           | Verified OSM-ref branch rank 1                                 | Six → four; rank 1, open REWE                 | REWE first; other branches removed after retrieval                     |
| EDEKA Moch Grunerstraße 999 Berlin        | No exact business/address assertion                            | Six rows; weak area search                    | Berlin area first; no invented exact tenant                            |
| Zzqxv430 Testladen Grunerstraße 20 Berlin | Invented business absent; address/number POIs returned         | Six → five; weak area search                  | Address first; no exact-business success                               |
| EDEKA Schaaf Schillingstraße 2 Berlin     | Verified OSM-ref candidate rank 1, formatted address conflicts | Berlin area first, Schaaf rank 2; weak search | Berlin first, Schaaf second                                            |

There are nine positive exact-entity queries: five Moch, two MediaMarkt, one REWE,
one Schaaf. Strict verified-entity Hit@3 is **4/9** at raw, adapted, combined and
pinned ranked place stages. The five Moch queries have **0/5 confirmed** hits;
three have the unresolved mall way, so the possible Hit@3 range is 4/9–7/9 if a
future independent identity judgment establishes that link. The name and full
Moch name/address queries still omit it. Unknown identity is not a false-branch
count or a successful hit. MediaMarkt ALEXA has one confirmed wrong-branch top row;
Schaaf's Berlin-area top row is not a business substitution. Both negatives have
zero claimed exact business matches, but generic fallback rows are retained.

Across the 13 queries, the place-only replay reduces **78 combined rows to 65**
after shared merge/ranking. The EDEKA and REWE branch losses occur there, separately
from retrieval (#429). Do not require future implementations to reproduce these
defects: `replay-v1.json` is historical evidence, while `replay.ts` identifies the
code actually used for a new replay. Live lists independently confirm the main
ordering/count outcomes; REWE's UI capture recorded only its geocoder fetch
(aggregate cache reuse was not network-observed in that interaction).

The two actual Enter observations are explicitly recorded; the other Enter
actions in the table are **source replay**, not observed navigation. Saved/recent
and category/brand/preset shortcuts were excluded from that place-only replay.
UI brand shortcuts and the appended area-search row are not counted as retrieved
businesses. The older label/radius pilot must not mark `poi.39267497` verified
solely because it lies near the mall.

Timings for 13 requests per layer, in milliseconds:

| Layer                       | Min / median / max       | Cache interpretation                                          |
| --------------------------- | ------------------------ | ------------------------------------------------------------- |
| Raw MapTiler                | 52.47 / 275.82 / 506.45  | Uncontrolled; provider generation/cache unknown               |
| Public adapted autocomplete | 86.58 / 160.29 / 524.77  | Uncontrolled; no cold/warm classification                     |
| Public aggregate            | 109.52 / 113.60 / 139.49 | Empty partial replies; not successful local retrieval latency |

These were 39 independent HTTP requests, with no retries in the query capture.
Public browser operations add their own requests and are not included in these 39. No p95 SLA, cold/warm success, indexed PostgreSQL latency or query-plan claim
is established. Bbox source acquisition took about 35s, with 2 DuckDB threads and
512MB configured memory limit; transfer bytes and peak RSS were not measured.
It is an offline inspection cost, not interactive-search latency.

## Concrete bounded follow-up design

Use a region-scoped **search-suggestions provider over the existing imported
Overture table**, enabled only for a local Berlin evaluation. Do not repurpose the
OSM alias index or install a source pipeline. Begin with primary/common names,
source-provided brand names and address tokens in a separate release-keyed lexical
index/view; retain source tables and credits separately. Evaluate an exact/prefix
index first, then optional PostgreSQL trigram fallback only if needed. No embedding
or model service is needed to test this hypothesis.

1. Normalize Unicode/case and German street spellings, preserving original display
   values. Decompose terminal street+house number+city when recognized. Retrieve
   with name/brand token coverage **and** parsed address constraints; `Moch` and
   house number `999` cannot be discarded to make a convenient same-brand match.
   Require token boundaries; `Alexa` is not evidence for `Alexanderstraße`.
2. Resolve a mall suffix to an independently known mall identity/footprint and
   use a verified containment/address association as context. Do not invent an
   `Alexa` alias on a business or expand every unmatched word to a city. Until
   such association is available, name-only Moch/address queries are supported
   while `EDEKA Alexa` remains an explicit evaluation gap.
3. Return `overture:<GERS>` identity, source names, structured address, provenance,
   release and closure/unknown status through the existing composition. If
   adapting MapTiler's validated `osm:n/w/r` reference becomes necessary, handle
   that in a narrow reviewed adapter follow-up. Brand Wikidata IDs describe the
   chain, not the branch. Proximity/shared mall address/phone switchboards alone
   cannot establish identity. Conflicting addresses/contacts stay separate; a
   verified OSM↔GERS link may merge only with retained IDs and credits.
4. Exclude permanently closed records; retain null status as unknown, and do not
   reinterpret a current opening-hours “Closed” badge as permanent closure.
   Carry Meta/Foursquare/Overture attribution using the existing contributor
   mapping and release gates. The two MediaMarkt GERS records need a verified
   duplicate judgment; the café inside MediaMarkt is a separate tenant.
5. Bound candidate acquisition to at most 30 rows, local output to 8 and the
   existing combined API limit to 8 (hard route maximum 20), UI maximum 10. One
   bounded SQL operation per query, no per-result remote enrichments in candidate
   generation. Preserve explicit remote-city/address search instead of forcing
   all business queries to the nearest branch.
6. Use a 300ms database deadline inside the existing 1,200ms provider deadline.
   Proposed local-provider p95 budget: cold ≤500ms, warm ≤150ms; total interaction
   pilot ceilings remain cold ≤5,000ms/warm ≤2,000ms from #424. These are proposed
   gates, not measured achievements. Release/index epoch, normalized query,
   language, region and proximity partition the isolated evaluation cache; test
   both query orders and cold/warm runs. Do not cache timeouts/partial failures as
   authoritative misses. Missing/unready index or timeout leaves normal geocoder
   fallback available and reports partial/unavailable state.

Map candidates to the existing `SearchSuggestion` envelope: `id=overture:<GERS>`,
`ids.overture=<GERS>`, `type=poi`, localized primary name as `label`, formatted
address as `sublabel`, coordinates, provider/source IDs, and `searchMatch` with
the retained matched name (`name` or explicitly permitted `near_name`). Use a
neutral bounded `importance`; source confidence is not business prominence.
The envelope does not carry arbitrary structured address/provenance fields.
Keep those, release and closure judgments in the source/audit row; return credits
through the provider's `attributions`. On selection, the existing `poi-overture`
resolver supplies structured place details and provenance. A local integration
must declare that resolver and PostGIS dependency, verify resolver readiness,
and freeze the same generation through candidate lookup and resolution. If that
dependency or the selected record is unavailable, report the failure and retain
fallback rather than silently substituting another branch. This wiring is a
follow-up design, not an enabled capability of the inspected deployment.

The promotion gate requires all nine verified positive queries in the first
three results, zero wrong-branch selections and false exact negative matches,
the unresolved mall identity either independently resolved or still marked unknown,
and preserved nearby/co-located branches after combination. Measure rank/recall
**before** merge/ranking and again after it; adopt applicable #428/#429 behavior
only in a separately pinned run. Their completion was not required to perform
this investigation. Add explicit remote city, ambiguous brand, closures, duplicate
GERS, contradictory addresses and language/order/cache controls before adoption.

Operational cost is a regional lexical index plus staged validation and cache
keys, not another upstream ingestion system. Measure table/index bytes, build
time, peak memory, EXPLAIN/BUFFERS and cold/warm query percentiles on a disposable
copy of the intended generation. Those costs are unknown here. Keep zero new
remote requests in the lexical path; exact absence, unavailable data and timeout
must remain distinguishable. A country-scale rebuild/rollout needs separate scope.

## Validation

The focused evaluation, adapter, ranking and term-extractor suite passed **127
tests in nine files**, including 17 new evidence tests. The evaluation TypeScript
check, offline replay and documentation production build passed. An independent
read-only review recomputed recall, row totals and timing summaries and verified
all 39 archived query-response hashes against fixture metadata. Historical
ranking is evidence, not an assertion that later #428/#429 fixes must preserve it.
The complete repository test suite and production database checks were not run;
there are no production code or schema changes in this PR.

## Admin inspection and completion status

Current **Services → Data workflows** already has Overture release/region/counts
and search-index epoch/publication/staleness controls. The OSM index description
correctly calls it code/alias/acronym search. A ready index is not evidence that
ordinary business names are searchable, and an Overture health “up” state is not
a named-business retrieval capability. `SearchIndexMaintenance` receives a source
fingerprint but does not display it in its summary; use the authenticated status
response to pin it. This is documented as an inspection detail rather than a UI
change because no local lexical feature is being enabled. Broad admin changes
would exceed the investigation's need.

Completed: source revision pin; public provider inventory and explicit unavailable
production metadata; official tenant/alternative identities; available OSM and
Overture IDs/provenance; 13-query raw/adapted/combined/ranked/live-list comparison;
two live Enter outcomes; strict branch/negative judgments; operational limits,
fallback, credits/closures and candidate design; versioned fixtures/offline checks;
go/no-go report. No prototype is required: the issue explicitly permits a concrete
candidate-integration design for data-present cases.

Remaining unknowns: deployed revision/chain order/generations/index health; exact
operator identity of the generic OSM mall way and its link to GERS; provider
generation and cache history; Overture REWE coverage outside the bbox; measured
lexical/PostgreSQL resource costs and controlled cold/warm latency. These limit
production adoption, not the completed bounded investigation. No merge or deploy
is authorized by this report.
