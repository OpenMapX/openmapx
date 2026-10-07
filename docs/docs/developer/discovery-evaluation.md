---
title: Discovery evaluation
description: Versioned offline discovery and navigation evidence, with a protocol for independently judged live comparisons.
---

# Discovery evaluation

Use this protocol before changing discovery, place enrichment or navigation. It
connects existing semantic search fixtures, conflation guards, Overture gates,
place-card and selected-sheet contracts and navigation replays. It does not turn synthetic tests
into evidence of current regional coverage or installed-device readiness.

## Run and compare

From the repository root:

```bash
pnpm discovery-eval --out /tmp/openmapx-eval-before
# Change application code, retaining the same inputs, cases and budgets.
pnpm discovery-eval --out /tmp/openmapx-eval-after \
  --baseline /tmp/openmapx-eval-before/report.json
```

The default output directory is ignored `.superpowers/eval-reports/latest`.
Keep a baseline outside that directory so a later run cannot overwrite it. Each
run writes `report.json` and `report.md`, with the application commit, dirty-tree
flag, SHA-256 fingerprints of input fixtures, assertion suites, expectations and
both map styles. Temporary Vitest evidence is removed after reporting; its error
stacks and arbitrary test payloads are excluded from the saved report.

Protocol version 2 rejects a baseline with another version, catalog, budgets or
case set or assertion inventory. Assertion names are retained as hashes, so a
shortened passing suite cannot silently replace complete baseline evidence.
Changed input fingerprints are listed separately from behavioral
regressions. `appOnlyComparison` requires unchanged fingerprints, unchanged observation
conditions/provider inputs, no supplied operator observations and two clean working trees; it establishes comparability, not causality. Commit intentional
changes before capturing review evidence. A local experiment in a dirty tree is
still useful, but its HEAD does not identify all code that ran.

The command invokes the existing suites without live provider requests. Those
suites and the report/capture regressions run through ordinary `pnpm test` in CI;
no paid API or deployed dataset is required. Exit status is nonzero for failed
runs, missing/skipped required automated assertions or a comparison regression.
Absent manual/unimplemented cases remain unavailable and do not block this offline
gate. Supplied reviewed observations are scored: failed budgets or lost previously
passing evidence produce a nonzero exit status. A live coverage failure is a useful
measurement, not evidence that the evaluation tool is broken.
A failure elsewhere in a selected suite still fails the run, even if individual
catalog cases passed.

## Cases and evidence layers

The versioned catalog is `scripts/discovery-eval/catalog.ts`. Its automated
expectations reuse existing tests, rather than scoring the current provider's
ordering as truth.

| Case family                                                        | Current evidence                                                                                                                                                             | Required live complement                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Stations, aliases, multilingual names, category queries and chains | Recorded adapted API inputs; independently specified expected labels, types, IDs and coordinate radii in `search-eval/cases.ts`                                              | Verify the desired entity and each branch against an independent source before re-recording     |
| Station synonyms and caches                                        | Mocked upstream cold/warm and query-order regressions; language/proximity partitions                                                                                         | Repeat both query orders on an isolated local cache with a fixed provider configuration         |
| Co-located tenants and branches                                    | Synthetic conflation guards for plural-per-address categories, contradictory contacts/addresses and shared switchboards                                                      | Judge actual tenants, entrances and floors; equal address does not establish identity           |
| Partial place cards and sheets                                     | Card and PlaceDetailContent contracts for photo/rating failures, absent/uncertain hours, photo detents, independent actions, loading, bounded retries and retained selection | Inspect missing facts and delayed requests in the browser with a pinned API revision            |
| Urban/rural categories                                             | Unit contracts for the reviewed Overture anchor gate in Aachen, Berlin, Monschau and Maastricht                                                                              | Run the staged-release gate against an exact imported generation and repeat the visual baseline |
| Closed/missing businesses                                          | Dated SEA LIFE closure and independently verified EDEKA tenant judgments; operator observations scored when supplied                                                         | Independently dated closure/existence judgments; filtering code alone is insufficient           |
| Transit transitions, recovery and GPS gaps                         | Synthetic shared-engine replays, including transfers and serialized recovery                                                                                                 | Installed shell, permissions, lifecycle and actual-device evidence under #398                   |
| Ground off-route behavior, arrival and alternatives                | Synthetic shared-engine assertions                                                                                                                                           | Repeat a real or independently recorded route with a pinned routing dataset                     |
| Offline place search and rerouting                                 | Unavailable pending #403 and #404                                                                                                                                            | Network-denial or airplane-mode evidence once those capabilities exist                          |

An assertion passes, fails or is unavailable. An explicitly guarded known gap is
reported as `known-gap`, rather than claiming its semantic expectation passed.
Reviewed observations list each absent evidence layer; installed/offline cases
describe the evidence still needed. Assertion counts may overlap
between cases and are not unique observations, recall values or production
performance measurements.

## Expectations and budgets before a comparison

Freeze the case IDs, expected entities/coordinates, assessor judgments and
acceptance rules before looking at changed results. Existing search expectations
use entity/type/label and coordinate radii; the aggregate floor is Hit@1 ≥ 0.80
and mean reciprocal rank ≥ 0.85 for the first expectation of asserted cases. This
is an offline ranking floor, not population-wide search accuracy.

The Overture baseline is tied to reviewed release `2026-07-22.0` and uses a
50-result window with per-case result-count, relevant-anchor recall,
known-irrelevant and known-duplicate ceilings. The offline command checks those
contracts; it does not compute today's regional metrics. Follow the
[Overture evaluation procedure](https://github.com/OpenMapX/openmapx/blob/main/services/data-manager/src/jobs/overture/eval/README.md)
for staged imports and independently labeled candidate pairs.

For live cases, write the following budgets into the capture manifest **before**
the comparison. Retain counts and denominators, including unknown judgments.

| Dimension              | Record and judge                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible discovery      | At each fixed viewport/zoom, count useful labels, overlap/occlusion and independently expected missing businesses; set the acceptable crowding ceiling   |
| Relevance and identity | Rank of independently expected entities; relevant/irrelevant/unjudged counts; duplicate, wrong branch, tenant and floor judgments                        |
| Requests and latency   | Cold/warm request counts and timings with cache/provider state; declare latency and request ceilings; do not infer them from Vitest duration             |
| Partial loading        | Stable row/selection/focus, distinct unknown versus closed facts, independently reachable credits/actions, stale-response isolation and retry budget     |
| Navigation             | Expected ordered events, mode/leg transitions, recovery state, off-route decisions and alternative selection; define acceptable location/time tolerances |

Avoid inventing a universal crowding or latency threshold from one capture. The
existing card enrichment batches eight items and limits dispatch attempts to two;
retain those contracts unless a reviewed change deliberately updates them.

## Pin the inputs and separate the outcomes

Use the [German map baseline](map-comparison-baseline.md) for fixed urban/rural
coordinates, zooms, searches and sheets. Keep its cases while adding new ones.
A live archive should contain a compact manifest with:

- Protocol/catalog revision, capture timestamp and assessor identity/date.
- Application/deployment commits (separately), dirty state and style checksums.
- Region/bounding box, viewport, DPR, language, zoom, pitch, bearing and theme.
- Selected provider/capabilities, hosted versus self-hosted mode and allowlisted
  non-secret settings that can affect ranking or rendering.
- Exact OSM extract date/hash, Overture release/generation and other source
  generations; explicitly `null` with a reason when unavailable.
- Independently expected entities/coordinates, judgments and predeclared budgets.
- Cache state, query order, request counts/timings and artifact checksums.
- Source licenses, permitted storage/access, redaction performed and limitations.

A fixture checksum identifies bytes, not their source date. Local Git HEAD does
not identify a remote deployment. The existing visual baseline records unknown
production revisions where they could not be observed; preserve that uncertainty.
Do not export `.env`, request headers, tokens or entire admin configuration.

Keep three evidence layers separate when diagnosing search:

1. **Raw upstream:** original provider payload and documented request parameters,
   captured by the operator only when provider terms allow. Redact credentials
   before storage; do not call a filtered response raw.
2. **Adapted API:** normalized/filtered API results with the deployment and adapter
   revision, capability/configuration and response ordering.
3. **Final UI:** client-ranked rows, selection/Enter outcome, map/sheet state and
   application/style revision.

Future `pnpm search-eval:record --api http://localhost:3001 [case-id …]`
recordings identify themselves as **adapted API, selected fields**, with a capture
time, local recorder revision/dirty flag and public API origin. They explicitly
leave remote deployment and source revisions unknown and do not include upstream
payloads. Credential/query/fragment-bearing base URLs are rejected without
printing their contents. Add independently observed remote/source revisions to
an operator manifest; do not infer them from the recorder's local commit. Existing
legacy fixtures are retained with unknown capture provenance.

## Cache and query-order isolation

Use an isolated local Redis/database or the existing mocked tests. Never flush a
shared production cache for evaluation. Record the cache implementation/version
and state; a warm response is a different condition from a cold response.

For station cases, run both orders on separate clean cache namespaces:
`Hauptbahnhof Neuss → Neuss Hauptbahnhof` and
`Neuss Hauptbahnhof → Hauptbahnhof Neuss`. Repeat warm, include `Hbf` aliases,
and vary language and proximity deliberately to test partitioning. Compare the
entity identity/coordinates and ordering at each evidence layer. The regression
in #389 is repaired in #392; this protocol retains the cases without replacing
that fix. Search forwarding and UI ranking are different stages.

## Store evidence outside Git

Keep capture archives in operator-controlled object storage or a release/archive
location with a stable URL, manifest and SHA-256 checksums. Preserve access needed
by reviewers; document retention and the source's redistribution rights. PR
screenshots should be direct GitHub attachments. Do not add new screenshot folders
to `docs/static/img` for evaluation runs.

Minimize personal data: use reviewed public places and synthetic navigation traces
where possible. Redact private locations, identifiers and credentials before
sharing. Provider photos, ratings and upstream payloads can have separate storage
or redistribution conditions; do not assume the repository's code license covers
them. Retain required source attribution. When a payload cannot be distributed,
record that limitation and permitted derived evidence instead.

## Reviewed pilot cases and operator manifest

`reviewed.ts` adds nine versioned cases with dated assessor judgments and public
source links: an exact REWE branch, MediaMarkt and EDEKA tenants in ALEXA, a joint
mall tenant inventory, permanently closed SEA LIFE Berlin, and zoom-15 landmarks
at the four existing urban/rural baseline cameras. Retailer websites establish
business identity independently of search ordering; OSM element versions locate
branches/landmarks. Mall coordinates are approximate, with explicit tolerances;
this pilot makes no entrance/floor claim. SEA LIFE's own profile establishes the
closure date. Recheck dated judgments before updating this corpus. A historical
listing with explicit closure context is allowed; an unqualified listing fails.
The mall inventory has no geocoder query: inspect the tenants together rather
than treating an invented query as a provider capability.

The pilot freezes these rules before comparison:

| Metric                               | Pilot rule                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Expected search entities             | All required entities within the first three results and their coordinate radii                          |
| Selected wrong branch                | Zero wrong-brand-branch selections in the first result; later alternative branches are allowed           |
| Duplicates / unqualified closed hits | Zero duplicates of an expected entity / zero excluded-entity hits without explicit closure context       |
| Browsing                             | Expected landmark anywhere in the fully readable set; at least one useful label; zero overlapping labels |
| Requests / latency                   | At most one request per captured operation; cold ≤5,000 ms, warm ≤2,000 ms                               |

These are small-pilot acceptance rules, not universal SLAs or population-wide
coverage thresholds. Uncontrolled-cache timings are retained but do not pass/fail
a cold/warm latency budget. Controlled cold/warm observations require declared isolated
cache conditions; a shared/unknown cache must be marked uncontrolled. Unmeasured values are `null`, not zero. A browsing
presentation observation lacking a readable-label or overlap judgment is
unavailable. Rendered feature counts include clipped/obscured labels and cannot
substitute for a visual judgment. Rank is not meaningful for an unordered map
feature set.

Supply an operator-owned JSON manifest:

```bash
pnpm discovery-eval --evidence /tmp/operator/manifest.json \
  --out /tmp/operator/report
```

Use `scripts/discovery-eval/examples/control-before.json` as the **schema example**,
not live evidence. Paths are resolved from the repository root. The strict schema
requires version, assessor/time, region, deployment/style/extract/source revisions,
provider/capabilities, reviewed-case query order, cache isolation,
language/theme/viewport/DPR and observations. Revisions are
`{ "value": null, "reason": "why unavailable" }` or a known value with a null
reason. The local app commit and owned style/input hashes are recorded separately;
a public runtime style checksum does not identify the deployment commit. A
replication timestamp does not prove the extract date/checksum. Do not copy an
old generation into a new manifest merely because the region is unchanged.

Each observation identifies its reviewed case, one evidence layer and processing
stage, provenance
(`live`, `recorded`, `synthetic`) and cache condition. Results contain only label,
`[longitude, latitude]` and whether closure context was explicitly shown. Capture
at the case's query/camera/zoom with zero pitch/bearing, and retain order for
search. Record request count, latency in ms, useful readable POI/park labels and
label-overlap count; use `null` for measurements not made. The schema rejects
unknown fields, invalid coordinates/counts and duplicate case/layer observations;
its errors omit rejected input. A single manifest is one capture per case/layer;
use separate manifests for cold/warm or query-order comparisons.

Layer meanings are fixed:

- `data` / `source`: independently inspected imported/source records, not inferred from API output.
- `provider` / `raw-upstream`: permitted raw-upstream capture projected onto the judged entities.
- `normalization` / `adapted-api` or `client-ranking`: distinct stages; use
  separate reports to inspect both. Unlike stages cannot produce numeric deltas.
- `presentation` / `final-ui`: final readable browser rows/labels, selection and sheet state.
- `runtime` / `engine-replay` or `installed-device`: observed execution, distinct from the automated navigation-engine
  replay cases in the main report.

Do not relabel adapted API output as upstream. Existing recorded client-ranking
cases and mocked adapter/cache cases remain separate in the automated catalog.
The report retains supplied context, definitions, budgets, numerical measurements
and each absent case/layer. Comparison reports list metric changes even when both
runs pass, changed source/configuration or capture conditions, changed data/provider
results, and lost passing evidence. Removing a previously measured value is an evidence
regression even if the remaining entity results pass. Unknown revisions remain unknown; identical
unknowns do not establish an application-only comparison. Operator manifests compare
observed captures; `appOnlyComparison` is reserved for clean offline assertion runs
without supplied observations, whose tested inputs are fingerprinted.

## Worked comparison and negative control

Run the committed, deliberately synthetic control fixtures:

```bash
pnpm discovery-eval --out /tmp/control-before \
  --evidence scripts/discovery-eval/examples/control-before.json
pnpm discovery-eval --out /tmp/control-after \
  --evidence scripts/discovery-eval/examples/control-after.json \
  --baseline /tmp/control-before/report.json
# The second command must exit 1: the selected REWE branch was deliberately moved.
```

Coordinate judgments reference [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright);
official website references supply independently reviewed public identity facts,
not permission to redistribute their pages or photos.

The fixtures use independently reviewed entity facts and invented measurements;
they contain no downloaded provider payloads or paid API requests. CI tests this
same comparison. This is a harness demonstration, not an application improvement:

| Outcome       | Before                                        | After                                      | Interpretation                                                                |
| ------------- | --------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Data          | Required branch present                       | Unchanged                                  | Synthetic source projection unchanged                                         |
| Provider      | Correct branch first                          | Unchanged                                  | Synthetic upstream projection unchanged                                       |
| Normalization | Recall 1, rank 1, wrong branch 0              | Recall 0, rank unavailable, wrong branch 1 | Deliberate normalized-result regression; reported separately                  |
| Presentation  | Landmark recall 1, useful labels 6, overlap 0 | Unchanged                                  | Synthetic readable-label judgment unchanged                                   |
| Runtime       | Existing navigation replays pass              | Unchanged                                  | Shared-engine synthetic evidence; installed/offline runtime still unavailable |

The command writes complete `report.json` and `report.md` in both output folders.
The after report has `runSucceeded: false` and the reviewed regression
`business/rewe-invalidenstrasse/normalization`, with no changed data/provider
inputs. A rank-1 → rank-2 change is also detected numerically even when it remains
within the top-three budget. Separate regression tests remove a tenant/business,
reintroduce an unqualified closed attraction, remove previous evidence and reject
tampered baseline metrics.

An October 7, 2026 read-only live pilot on OpenMapX.com illustrates the distinction:
REWE's exact branch appears; EDEKA's independently verified ALEXA business is
missing from its adapted autocomplete results. Four dark-theme phone viewports
(430×932, DPR 1, English, zoom 15) were visually inspected: Berlin's cathedral
feature exists but its label is clipped; Aachen's cathedral and Monschau's castle
are readable; Neuss's expected minster label is absent. These are observations of
that deployment, not universal judgments. The API cache was uncontrolled; raw
upstream, geocoder extract revisions and deployment commit were unavailable.
Keep the operator manifest/reports/screenshots outside Git, with checksums and
rights/access notes. A public observation is not a clean before/after experiment.

For navigation or station-search changes, the existing semantic assertions must
still fail when expected events/entities are lost. Do not weaken expectations to
make a changed result pass. Read results alongside their layers: data, provider,
normalization, presentation and installed runtime require different evidence.
