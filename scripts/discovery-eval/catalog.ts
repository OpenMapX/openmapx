import { EVAL_CASES } from "../../packages/core/src/utils/__tests__/search-eval/cases.js";
import { OVERTURE_QUALITY_BASELINE_RELEASE } from "../../services/data-manager/src/jobs/overture/eval/quality-baseline.js";
import type { EvalCase } from "./report.js";

const search = "packages/core/src/utils/__tests__/search-eval";
const navigation = "packages/core/src/navigation";
const overture = "services/data-manager/__tests__/overture";
const cards = "apps/web/src/components/panels/category/CategoryResultsContent.test.tsx";

/** Existing assertions stay authoritative; this is a catalog, not a second ranker. */
export const CATALOG: EvalCase[] = [
  ...EVAL_CASES.map((entry) => ({
    id: `search/${entry.id}`,
    layer: "client-ranking/recorded-adapted-api",
    suite: `${search}/search-eval.test.ts`,
    assertions: [`${entry.id}:`],
    fixtures: [`${search}/fixtures/${entry.id}.json`, `${search}/fixtures/_shared.json`],
    expected: entry,
    ...(entry.knownGap ? { knownGap: entry.knownGap } : {}),
  })),
  {
    id: "search/aggregate-ranking-budget",
    layer: "client-ranking/recorded-adapted-api",
    suite: `${search}/search-eval.test.ts`,
    assertions: ["keeps the first expectation at rank 1 for most cases"],
    expected: { hitAt1: 0.8, reciprocalRank: 0.85 },
  },
  {
    id: "search/station-synonyms-cache-order",
    layer: "adapted-api/mocked-upstream",
    suite: "integrations/geocoding/__tests__/forward-ranking.test.ts",
    note: "Cold/warm query order, station aliases, language/proximity isolation and provider-order fallback; mocked upstream, not provider coverage.",
  },
  {
    id: "search/location-cache-isolation",
    layer: "adapted-api/mocked-upstream",
    suite: "integrations/geocoding/__tests__/routes.test.ts",
  },
  {
    id: "identity/co-located-tenants",
    layer: "conflation/synthetic",
    suite: "packages/core/src/utils/__tests__/poiConflation.test.ts",
    note: "Includes plural-per-address restaurants, contradictory address/phone and shared switchboard guards; does not establish real mall floor identity.",
  },
  {
    id: "place/partial-enrichment-loading",
    layer: "ui/contract-fixtures",
    suite: cards,
    note: "Partial photos/ratings, independent credits, bounded retries, stale searches and missing data; no real-provider availability or production latency claim.",
  },
  {
    id: "coverage/overture-reviewed-gate-contract",
    layer: "dataset-gate/unit-fixtures",
    suite: `${overture}/eval/quality-gate.test.ts`,
    expected: { reviewedRelease: OVERTURE_QUALITY_BASELINE_RELEASE, resultWindow: 50 },
    note: "Berlin/Aachen/Monschau/Maastricht anchor gate contracts; this command does not query a deployed dataset or measure current regional recall.",
  },
  {
    id: "coverage/overture-metric-contract",
    layer: "dataset-gate/unit-fixtures",
    suite: `${overture}/eval/metrics.test.ts`,
  },
  {
    id: "coverage/overture-search-quality-contract",
    layer: "dataset-gate/unit-fixtures",
    suite: `${overture}/eval/search-quality.test.ts`,
  },
  {
    id: "navigation/transit-recovery-gps-gaps",
    layer: "navigation-engine/synthetic-replay",
    suite: `${navigation}/mobileReplay.test.ts`,
    fixtures: ["ground-basic", "transit-basic", "transit-tunnel", "transit-transfer"].map(
      (name) => `${navigation}/__fixtures__/mobile/${name}.json`,
    ),
    note: "Deterministic transfers, serialization/recovery and GPS gap confidence. Not installed shell/device verification.",
  },
  {
    id: "navigation/ground-off-route-arrival",
    layer: "navigation-engine/synthetic",
    suite: `${navigation}/__tests__/processFix.test.ts`,
  },
  {
    id: "navigation/alternative-route",
    layer: "navigation-engine/synthetic",
    suite: `${navigation}/fasterRoute.test.ts`,
  },
  {
    id: "manual/urban-rural-browsing",
    layer: "ui/live-manual",
    unavailable:
      "Repeat the map comparison baseline at fixed viewport, coordinates, zoom and provider/style/source revisions; attach external capture manifest and judgments.",
  },
  {
    id: "manual/closed-missing-businesses",
    layer: "dataset/live-manual",
    unavailable:
      "Independently verify a stratified regional sample of missing/closed businesses against exact OSM/Overture generations; no current closure ground truth is captured here.",
  },
  {
    id: "manual/mall-tenant-floor-identity",
    layer: "dataset/live-manual",
    unavailable:
      "Independently judge tenants, branches, entrances and floors; synthetic conflation guards do not establish regional coverage.",
  },
  {
    id: "manual/provider-performance",
    layer: "adapted-api/live-manual",
    unavailable:
      "Declare request/latency budgets and repeat cold/warm captures in both query orders, with explicit region/configuration/source revisions.",
  },
  {
    id: "unavailable/installed-navigation",
    layer: "installed-device",
    unavailable:
      "Installed navigation composition and device evidence pending #398; shared-engine replays are separate.",
  },
  {
    id: "unavailable/offline-place-search",
    layer: "installed-device/offline",
    unavailable:
      "Offline place/address search pending #403; downloaded map tiles are not offline search.",
  },
  {
    id: "unavailable/offline-rerouting",
    layer: "installed-device/offline",
    unavailable:
      "Android offline routing/rerouting prototype pending #404; no airplane-mode engine measurement in this corpus.",
  },
];

export const INPUT_FILES = [
  ...new Set([
    ...CATALOG.flatMap((entry) => [
      ...(entry.fixtures ?? []),
      ...(entry.suite ? [entry.suite] : []),
    ]),
    `${search}/cases.ts`,
    "services/data-manager/src/jobs/overture/eval/quality-baseline.ts",
    "apps/web/public/styles/openmapx-streets.json",
    "apps/web/public/styles/openmapx-dark.json",
  ]),
].sort();
