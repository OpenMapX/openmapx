---
title: Discovery evaluation
description: Versioned offline discovery and navigation evidence, with a protocol for independently judged live comparisons.
---

# Discovery evaluation

Use this protocol before changing discovery, place enrichment or navigation. It
connects existing semantic search fixtures, conflation guards, Overture gates,
place-card contracts and navigation replays. It does not turn synthetic tests
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

Protocol version 1 rejects a baseline with another version, catalog, budgets or
case set or assertion inventory. Assertion names are retained as hashes, so a
shortened passing suite cannot silently replace complete baseline evidence.
Changed input fingerprints are listed separately from behavioral
regressions. `appOnlyComparison` requires unchanged fingerprints and two clean
working trees; it establishes comparability, not causality. Commit intentional
changes before capturing review evidence. A local experiment in a dirty tree is
still useful, but its HEAD does not identify all code that ran.

The command invokes the existing suites without live provider requests. Those
suites and the report/capture regressions run through ordinary `pnpm test` in CI;
no paid API or deployed dataset is required. Exit status is nonzero for failed
runs, missing/skipped required automated assertions or a comparison regression.
Manual/unimplemented cases remain unavailable and do not block this offline gate.
A failure elsewhere in a selected suite still fails the run, even if individual
catalog cases passed.

## Cases and evidence layers

The versioned catalog is `scripts/discovery-eval/catalog.ts`. Its automated
expectations reuse existing tests, rather than scoring the current provider's
ordering as truth.

| Case family                                                        | Current evidence                                                                                                                | Required live complement                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Stations, aliases, multilingual names, category queries and chains | Recorded adapted API inputs; independently specified expected labels, types, IDs and coordinate radii in `search-eval/cases.ts` | Verify the desired entity and each branch against an independent source before re-recording     |
| Station synonyms and caches                                        | Mocked upstream cold/warm and query-order regressions; language/proximity partitions                                            | Repeat both query orders on an isolated local cache with a fixed provider configuration         |
| Co-located tenants and branches                                    | Synthetic conflation guards for plural-per-address categories, contradictory contacts/addresses and shared switchboards         | Judge actual tenants, entrances and floors; equal address does not establish identity           |
| Partial place cards                                                | Contract fixtures for photo/rating failures, independent credits, loading, bounded retries and stale searches                   | Inspect missing facts and delayed requests in the browser with a pinned API revision            |
| Urban/rural categories                                             | Unit contracts for the reviewed Overture anchor gate in Aachen, Berlin, Monschau and Maastricht                                 | Run the staged-release gate against an exact imported generation and repeat the visual baseline |
| Closed/missing businesses                                          | Manual case, unavailable in this command                                                                                        | Independently dated closure/existence judgments; filtering code alone is insufficient           |
| Transit transitions, recovery and GPS gaps                         | Synthetic shared-engine replays, including transfers and serialized recovery                                                    | Installed shell, permissions, lifecycle and actual-device evidence under #398                   |
| Ground off-route behavior, arrival and alternatives                | Synthetic shared-engine assertions                                                                                              | Repeat a real or independently recorded route with a pinned routing dataset                     |
| Offline place search and rerouting                                 | Unavailable pending #403 and #404                                                                                               | Network-denial or airplane-mode evidence once those capabilities exist                          |

An assertion passes, fails or is unavailable. An explicitly guarded known gap is
reported as `known-gap`, rather than claiming its semantic expectation passed.
Manual cases describe the evidence still needed. Assertion counts may overlap
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

## Sample comparison and negative control

An initial offline run of this catalog produced 99 passing cases and seven
unavailable manual/device/offline cases, with no guarded known gaps. A second run
on unchanged inputs produced no regressions and no changed fingerprints. The
working tree was dirty during development, so neither was an application-only
comparison. These counts describe this corpus, not the number of supported
product features.

As a negative control, temporarily remove the autocomplete and aggregate records
from `aachen-hbf-alone.json` in an isolated checkout, retaining its independently
expected station. The search assertion must fail; the comparison must list
`search/aachen-hbf-alone` as a regression and the fixture as a changed input.
Restore the exact original bytes and rerun. This proves the harness notices lost
results without attributing a dataset change to application code. Keep negative
controls temporary; do not weaken expectations or commit the corrupted fixture.

Read report results alongside their layers and limitations. A provider/data
change, normalization change, presentation change and installed runtime change
require different evidence, even when the same place is involved.
