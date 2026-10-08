# Business name/address regression corpus

Reusable inputs from [#430](https://github.com/OpenMapX/openmapx/issues/430).
See the [findings and follow-up](../../../docs/docs/developer/business-name-address-retrieval.md).
This directory implements no search provider or ingestion process.

- `queries-v1.json`: 13 frozen queries, expected identities/negatives and budgets.
  Alexanderstraße remains unresolved, outside exact-business recall.
- `responses-v1.json`: 52 distinct selected raw MapTiler features and adapted rows,
  reused by ID across queries. Fixed inputs captured 2026-10-07; neither projection
  is a full payload or a claim about today's provider/deployment.
- `sources-v1.json`: compact reviewed OSM/Overture identity/provenance records.
  A shared mall address or brand is not a verified business cross-link.
- `evidence.test.ts`: real-adapter identity/order parity and specialized OSM
  term-extractor behavior. Tests do not freeze historical ranking or UI state.
- `replay.ts`: current-checkout place-only combination/ranking/Enter comparison
  over fixed inputs. It reports its own revision/dirty state. The historical
  aggregate was empty/partial; absence from it proves no source gap. Shortcuts,
  recents and actual UI observations are separate evidence.

```sh
pnpm exec vitest run scripts/discovery-eval/business-name-address/evidence.test.ts
pnpm exec tsc -p scripts/discovery-eval/business-name-address/tsconfig.json
pnpm -C packages/cli exec tsx ../../scripts/discovery-eval/business-name-address/replay.ts \
  --out /tmp/business-retrieval-replay.json
```

## External captures and recapture

The [dated capture archive](https://gist.github.com/Medformatik/c36d8b8f44c88971277659512a533a51/8b33cd9238ba743f54f3235f2831470cf3bb5972) preserves historical request parameters,
response hashes/timings, full selected per-query lists, source acquisition details,
UI observations, status limitations and the original report. `checksums.json`
binds its exact bytes. These remain audit records rather than CI expectations.
The report links the reviewed 2026-10-08 lexical probe, its disposable container
command, measured costs and remaining adoption gates. Full raw operator
files and execution logs were temporary and are not a durable public artifact.

For recapture, use query file order. Fetch raw MapTiler and public adapter/aggregate
layers independently. Match the adapter's rounded `[13.42,52.52]` upstream anchor;
EN, zoom 15, MapTiler limit 6/autocomplete true/types including POI, aggregate
limit 8. Use an operator-owned key; never print or store it. Capture timestamps,
parameters, status and byte hashes before projection. Record remote deployment,
provider/generation and cache conditions separately, unknown when unavailable.
Use isolated caches for cold/warm claims. Freeze a new version for changed
judgments; do not replace historical fixtures with live responses.

## Source credits and rights

© MapTiler, © OpenStreetMap contributors. MapTiler search results remain subject
to [MapTiler Cloud terms](https://www.maptiler.com/terms/cloud/), including export
permission in section 6.4 and database attribution in section 6.3. OSM: ©
OpenStreetMap contributors, [ODbL-1.0](https://www.openstreetmap.org/copyright).
Overture/Meta: [CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). Foursquare:
[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0), copyright Foursquare Labs.
Selected source records retain applicable dataset/license IDs. External samples
are not relicensed as application code; official retailer pages establish
identity facts, not permission to redistribute their pages or photos.
