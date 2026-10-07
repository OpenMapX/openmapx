# Berlin business name/address investigation v1

Evidence for [#430](https://github.com/OpenMapX/openmapx/issues/430), captured on
2026-10-07. Read the [go/no-go report](../../../docs/docs/developer/business-name-address-retrieval.md)
for identity judgments, conditions, limitations and the bounded integration design.
This directory is evaluation material; it implements no search provider.

- `queries-v1.json`: frozen query expectations and budgets. The Alexanderstraße
  control has unresolved business identity and no required-entity judgment.
- `responses-v1.json`: **selected fields**, independently captured raw MapTiler
  features, public adapted rows and aggregate replies; timestamps, request
  parameters, status, response hashes and uncontrolled-cache timings. Raw feature
  order is retained. Neither projection is a full payload.
- `sources-v1.json`: reviewed OSM elements and five Overture records, source
  IDs/versions, release, provenance, license fields and bbox-acquisition hashes.
- `replay-v1.json`: historical place-only combination/ranking/Enter trace at
  `3c80939d26a09f131b16d849895255436b5e5798`. It is not a future ranking contract.
- `ui-v1.json`: independently observed live DOM rows and request IDs at the fixed
  Berlin camera, followed by two actual Enter outcomes. The deployment SHA is
  unknown; these are not observations of the locally pinned application.
- `evidence.test.ts`: offline fixture/provenance checks and replay through the
  real MapTiler adapter. It does not require future rankers to retain #428/#429.
- `replay.ts`: rerun place-only composition with the current checkout, reporting
  its revision separately. Saved places, recents, categories, brands and presets
  are omitted deliberately; the live UI evidence includes the actual dropdown.

```sh
pnpm exec vitest run scripts/discovery-eval/business-name-address/evidence.test.ts
pnpm exec tsc -p scripts/discovery-eval/business-name-address/tsconfig.json
pnpm -C packages/cli exec tsx ../../scripts/discovery-eval/business-name-address/replay.ts \
  --out /tmp/business-retrieval-replay.json
```

For recapture, use the queries in file order. Fetch the three layers separately:
MapTiler `/geocoding/{encoded-query}.json` with an operator-owned key and the
recorded parameters; OpenMapX `/api/integrations/geocoding/autocomplete`; and
`/api/integrations/search-suggestions/search` with `limit=8`. The API rounds the
autocomplete anchor to `[13.42,52.52]`; do not send the unrounded point directly
to MapTiler when comparing it to that adapter path. Never print or save the key.
Capture HTTP status and hash the response bytes before projecting them. Empty
partial/error results cannot establish source absence. Use an isolated cache for
any cold/warm budget claim. Freeze a new version for changed judgments; do not
overwrite v1 with current network results.

OSM can be rechecked via `https://api.openstreetmap.org/api/0.6/map` with the
recorded bbox and direct element endpoints. The bounded Overture acquisition used
Python DuckDB 1.5.6, `httpfs`, two threads and a 512MB memory limit:

```sql
SELECT id, version, names, addresses, phones, websites, brand, confidence,
       operating_status, sources, bbox
FROM read_parquet(
  's3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/*'
)
WHERE bbox.xmin BETWEEN 13.408 AND 13.426
  AND bbox.ymin BETWEEN 52.513 AND 52.527;
```

This is a point/bbox-origin predicate for this Places sample, not a general
polygon-intersection query. It returned 3,255 unfiltered rows; only reviewed
business records are committed. REWE is outside that bbox and its Overture
presence was not inspected. Full raw files and screenshots remain in the task's
local operator archive `/tmp/openmapx-430`; that temporary path is not a durable
public archive. The selected fixtures make the report reviewable without it.

## Source credits and rights

© MapTiler, © OpenStreetMap contributors. MapTiler search results remain subject
to [MapTiler Cloud terms](https://www.maptiler.com/terms/cloud/), including the
search-results export permission in section 6.4 and database attribution in
section 6.3. These samples are not relicensed as application code.

OSM records: © OpenStreetMap contributors, [ODbL-1.0](https://www.openstreetmap.org/copyright).
Overture release: © Overture Maps Foundation and contributing datasets. The
selected records retain Meta and Overture `CDLA-Permissive-2.0` provenance and
Foursquare `Apache-2.0` provenance. See the upstream
[data documentation](https://github.com/OvertureMaps/data/blob/main/README.md)
and each retained `sources[]` entry. There is no inference that the code license
covers external data. No credentials, cookies, admin configuration or OSM
contributor account identifiers are retained.
