# Overture and OSM conflation evaluation

Use this harness to compare Overture Places and OpenStreetMap POI conflation
thresholds against human-labelled candidate pairs. The harness reads the entire
installed source tables into memory, so use a small, disposable regional dataset.
Do not run the preparation or threshold experiments against a live production
database.

The preparation commands below run from the repository root through a
data-manager configured for that disposable environment. The evaluation commands
run from `services/data-manager/` and require `DATABASE_URL` for the same database
in the shell. See the [Overture guide](../../../../../../docs/docs/features/overture-places.md)
for source preparation and publication requirements.

## Workflow

### 1. Pull Overture data

```sh
pnpm openmapx data overture-pull europe/germany/berlin
pnpm openmapx data overture-ingest europe/germany/berlin
```

### 2. Extract OSM POIs

```sh
pnpm openmapx data download osm europe/germany/berlin
pnpm openmapx data overture-extract europe/germany/berlin
```

### 3. Generate candidates.tsv

Change to `services/data-manager/` and run the harness without `--labeled`. It reads both tables from the DB,
generates up to 300 stratified candidate pairs, and writes `candidates.tsv`:

```sh
node --import tsx/esm src/jobs/overture/eval/run.ts \
  --output candidates.tsv
```

Pairs are stratified across four name-similarity bands to avoid oversampling
near-identical matches:

| Band     | nameDice range |
| -------- | -------------- |
| Low      | 0.0 – 0.4      |
| Mid-low  | 0.4 – 0.7      |
| Mid-high | 0.7 – 0.9      |
| High     | ≥ 0.9          |

### 4. Label the pairs

Open `candidates.tsv` and add an `isMatch` column (`true`/`false`) for each
row: `true` if the OSM POI and Overture place refer to the same real-world place,
`false` for coincidental proximity.

### 5. Run the sweep

```sh
node --import tsx/esm src/jobs/overture/eval/run.ts \
  --labeled candidates-labeled.tsv \
  --output results.json
```

The harness loads OSM POIs and Overture places from the DB, sweeps 54 threshold
combinations (3 × 3 × 3 × 2), and prints a table ranked by F1. The sweep calls
the real `conflate()` from `packages/core`; `confidenceFloor` is applied as a
pre-filter on Overture rows (dropping low-confidence and permanently-closed
places) before conflation — it is **not** a conflation threshold.

Pick the top row whose precision ≥ 0.95 (low false-positive rate matters most
for the augment-only strategy).

### 6. Apply the chosen thresholds

Update `DEFAULT_CONFLATION_THRESHOLDS` in
`packages/core/src/utils/poiConflation.ts` with the winning `alwaysMergeM`,
`softWindowM`, and `nameDiceFloor`. The `confidenceFloor` from the winning cell
becomes the runtime pre-filter value in the ingest job, not part of
`ConflationThresholds`.

## Permanent staged-release quality gate

Every import runs `quality-gate.ts` against the staging schema before the
atomic activation swap. The committed human-reviewed corpus in
`quality-baseline.ts` contains stable GERS anchors, known category mistakes,
and known duplicates for four environments:

- Aachen (medium German city)
- Berlin (large German city)
- Monschau (rural Germany)
- Maastricht (non-German city)

Cases cover cafés, restaurants, supermarkets, pharmacies, hotels, and fuel and
are applied only when their most-specific Geofabrik region is contained
by the imported region. For example, a Germany import runs all three German
cases, while a Netherlands import runs Maastricht. A region with no applicable
case is reported as zero applicable cases and is not blocked.

The pre-activation gate uses the same taxonomy fields, confidence floor,
production ordering, and top-50 limit as Overture POI search. After exact link
assignment, the same corpus also evaluates the final fused OSM + Overture
response before link publication. It blocks activation when anchor recall
or result count drops below its reviewed floor, or when known irrelevant and
duplicate hits exceed the recorded ceiling. Updating a judgment requires
checking the named place and coordinates against the new release and recording
the new release in `OVERTURE_QUALITY_BASELINE_RELEASE`; never relax a threshold
only to make a release pass.

## File reference

| File                    | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `metrics.ts`            | `computeMetrics` + `SWEEP_GRID` (54 cells)    |
| `candidates.ts`         | `generateCandidatePairs` with band sampling   |
| `run.ts`                | CLI entrypoint — loads labels, sweeps, prints |
| `search-quality.ts`     | Overture-only relevance and duplicate metrics |
| `search-quality-run.ts` | CLI for labeled search-result JSON            |
| `quality-baseline.ts`   | Permanent multi-region human-reviewed corpus  |
| `quality-gate.ts`       | Pre-activation staged-release regression gate |

## Overture-only search quality

Conflation metrics do not measure the relevance or ordering of Overture-only
gap-fill. Capture production-ordered category responses for representative
regions and label each returned result with `relevant` and, when applicable,
`duplicateOf`. Record the assessor's `totalRelevant` count for recall. The pure
`evaluateSearchQuality` helper reports macro precision@50, recall@50, mean
reciprocal rank, and duplicate rate, making before/after ranking changes
comparable without coupling the evaluator to a running API.

```sh
node --import tsx/esm src/jobs/overture/eval/search-quality-run.ts \
  --labeled search-quality-aachen.json
```

The JSON-compatible case shape is:

```json
{
  "query": "cafes in Aachen",
  "totalRelevant": 2,
  "results": [
    { "id": "overture:…", "relevant": true },
    { "id": "overture:…", "relevant": false },
    { "id": "overture:…", "relevant": true, "duplicateOf": "overture:…" }
  ]
}
```
