import { createHash } from "node:crypto";
import { haversineDistance } from "../../packages/core/src/utils/coordinates.js";

export const REVIEW_VERSION = 1;
export const LAYERS = ["data", "provider", "normalization", "presentation", "runtime"] as const;
export const STAGES = {
  data: ["source"],
  provider: ["raw-upstream"],
  normalization: ["adapted-api", "client-ranking"],
  presentation: ["final-ui"],
  runtime: ["engine-replay", "installed-device"],
} as const;
type Stage = (typeof STAGES)[keyof typeof STAGES][number];
type Layer = (typeof LAYERS)[number];
interface Entity {
  label: string;
  aliases?: string[];
  coordinates: [number, number];
  radiusMeters: number;
  disposition: "required" | "excluded";
  address: string;
  evidence: string[];
  judgment: string;
}
export interface ReviewedCase {
  id: string;
  query: string;
  center: [number, number];
  zoom: number;
  entities: Entity[];
  assessor: string;
  assessedAt: string;
  budgets: {
    maxRank: number;
    minimumRecall: number;
    maxDuplicates: number;
    maxWrongBranch: number;
    maxForbiddenHits: number;
    minimumUsefulLabels: number;
    maxOverlaps: number;
    maxRequests: number;
    coldLatencyMs: number;
    warmLatencyMs: number;
  };
}
// Pilot acceptance rules, frozen before comparison; not universal product SLAs.
const budgets = {
  maxRank: 3,
  minimumRecall: 1,
  maxDuplicates: 0,
  maxWrongBranch: 0,
  maxForbiddenHits: 0,
  minimumUsefulLabels: 1,
  maxOverlaps: 0,
  maxRequests: 1,
  coldLatencyMs: 5000,
  warmLatencyMs: 2000,
};
const reviewed = {
  assessor: "Codex assisted primary-source review",
  assessedAt: "2026-10-07",
  zoom: 15,
  budgets,
};
const rewe: Entity = {
  label: "REWE",
  address: "Invalidenstraße 158, Berlin",
  coordinates: [13.3970838, 52.5319807],
  radiusMeters: 120,
  disposition: "required",
  evidence: [
    "https://www.rewe.de/marktseite/berlin-mitte/1350030/rewe-markt-ackerstr-23-26-invalidenstr-158/",
    "https://www.openstreetmap.org/node/348000444/history/29",
  ],
  judgment:
    "Official address and OSM node v29 independently identify this branch; another REWE cannot substitute.",
};
const edeka: Entity = {
  label: "EDEKA",
  address: "Grunerstraße 20, Berlin (ALEXA)",
  coordinates: [13.416, 52.5194],
  radiusMeters: 200,
  disposition: "required",
  evidence: ["https://www.edeka.de/maerkte/408935/"],
  judgment:
    "Official EDEKA Moch address verifies the tenant. Approximate mall footprint with 200m tolerance; no entrance/floor accuracy claim. A street-address result is not this business.",
};
const media: Entity = {
  label: "MediaMarkt",
  address: "Grunerstraße 20, Berlin (ALEXA)",
  coordinates: [13.4147909, 52.5198615],
  radiusMeters: 120,
  disposition: "required",
  evidence: [
    "https://www.mediamarkt.de/de/store/berlin-mitte-190",
    "https://www.openstreetmap.org/node/322490364/history/24",
  ],
  judgment:
    "Official tenant address plus OSM node v24. Distinct from EDEKA at the same street address; no floor inference.",
};
export const REVIEWED_CASES: ReviewedCase[] = [
  {
    ...reviewed,
    id: "business/rewe-invalidenstrasse",
    query: "REWE Invalidenstraße 158",
    center: [13.3970838, 52.5319807],
    entities: [rewe],
  },
  {
    ...reviewed,
    id: "business/mediamarkt-alexa",
    query: "MediaMarkt Alexa",
    center: [13.4147909, 52.5198615],
    entities: [media],
  },
  {
    ...reviewed,
    id: "business/edeka-alexa",
    query: "EDEKA Moch Grunerstraße 20",
    center: [13.416, 52.5194],
    entities: [edeka],
  },
  {
    ...reviewed,
    id: "business/alexa-tenants",
    query: "",
    center: [13.416, 52.5194],
    entities: [media, edeka],
  },
  {
    ...reviewed,
    id: "business/sealife-closed",
    query: "SEA LIFE Berlin",
    center: [13.4028, 52.5203],
    entities: [
      {
        label: "SEA LIFE",
        address: "Berlin-Mitte historical attraction site (approximate)",
        coordinates: [13.4028, 52.5203],
        radiusMeters: 300,
        disposition: "excluded",
        evidence: ["https://lnk.bio/sealifeberlin"],
        judgment:
          "The attraction's own profile states permanent closure since 2024-12-13. Do not present it as an operating business; historical listings require explicit closure context. Approximate former-site coordinate.",
      },
    ],
  },
  ...(
    [
      [
        "berlin",
        "Berliner Dom",
        [13.404914, 52.520407],
        [13.400966, 52.519082],
        "https://www.berlinerdom.de/anfahrt/",
        "https://www.openstreetmap.org/way/313670734/history/78",
      ],
      [
        "aachen",
        "Aachen Cathedral",
        [6.0839, 50.7754],
        [6.083957, 50.774744],
        "https://www.aachenerdom.de/en/",
        "https://www.openstreetmap.org/way/20470246/history/83",
      ],
      [
        "neuss",
        "Quirinus",
        [6.6916, 51.1982],
        [6.693343, 51.199047],
        "https://www.neuss.de/erleben/geschichte/neuss-historisch/quirinus-muenster",
        "https://www.openstreetmap.org/way/28562993/history/35",
      ],
      [
        "monschau",
        "Burg Monschau",
        [6.2407, 50.5545],
        [6.2397285, 50.5532282],
        "https://www.monschau.de/kalender/terminanfragen/2026-08-23-burgsommer-2026-klassik-unter-sternen/",
        "https://www.openstreetmap.org/node/5004288699/history/7",
      ],
    ] as const
  ).map(([id, label, center, coordinates, url, osm]) => ({
    ...reviewed,
    id: `browsing/${id}-z15`,
    query: "",
    center: [...center] as [number, number],
    entities: [
      {
        label,
        aliases:
          id === "berlin"
            ? ["Berlin Cathedral"]
            : id === "aachen"
              ? ["Aachener Dom"]
              : id === "monschau"
                ? ["Monschau Castle"]
                : [],
        address: `${id} fixed baseline viewport`,
        coordinates: [...coordinates] as [number, number],
        radiusMeters: 200,
        disposition: "required" as const,
        evidence: [url, osm],
        judgment:
          "Official site verifies the named landmark independently of map ordering. Independent OSM geometry centroid/node with 200m tolerance, not an entrance survey; camera coordinates are not search expectations. Count fully readable useful labels and overlapping labels independently of queryRenderedFeatures counts.",
      },
    ],
  })),
];

export interface Observation {
  caseId: string;
  layer: Layer;
  stage: Stage;
  kind: "live" | "recorded" | "synthetic";
  cache: "cold" | "warm" | "uncontrolled";
  results: Array<{ label: string; coordinates: [number, number]; closed: boolean }>;
  measurements: {
    requests: number | null;
    latencyMs: number | null;
    usefulLabels: number | null;
    overlaps: number | null;
  };
}
type Revision = { value: string | null; reason: string | null };
export interface Manifest {
  version: 1;
  assessedAt: string;
  assessor: string;
  context: {
    queryOrder: string[];
    cacheIsolation: "isolated" | "shared" | "unknown";
    region: string;
    extractDate: Revision;
    style: Revision;
    deployment: Revision;
    sources: { osm: Revision; overture: Revision };
    provider: { id: string; capabilities: string[] };
    configuration: {
      language: string;
      theme: "light" | "dark";
      viewport: [number, number];
      dpr: number;
    };
  };
  observations: Observation[];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 500;
}
function pair(value: unknown, coordinates = true): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (coordinates
      ? Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
      : value.every((n) => n > 0))
  );
}
function revision(value: unknown) {
  return (
    object(value) &&
    keys(value, ["value", "reason"]) &&
    (value.value === null ? text(value.reason) : text(value.value) && value.reason === null)
  );
}
/** Only known non-secret fields survive; never echo rejected input in errors. */
export function readManifest(value: unknown): Manifest {
  const fail = () => {
    throw new Error("Invalid discovery evidence manifest");
  };
  if (
    !object(value) ||
    !keys(value, ["version", "assessedAt", "assessor", "context", "observations"]) ||
    value.version !== 1 ||
    !text(value.assessedAt) ||
    !Number.isFinite(Date.parse(value.assessedAt)) ||
    !text(value.assessor)
  )
    return fail();
  const c = value.context;
  if (
    !object(c) ||
    !keys(c, [
      "queryOrder",
      "cacheIsolation",
      "region",
      "extractDate",
      "style",
      "deployment",
      "sources",
      "provider",
      "configuration",
    ]) ||
    !Array.isArray(c.queryOrder) ||
    !c.queryOrder.every((id) => REVIEWED_CASES.some((entry) => entry.id === id)) ||
    typeof c.cacheIsolation !== "string" ||
    !["isolated", "shared", "unknown"].includes(c.cacheIsolation) ||
    !text(c.region) ||
    !revision(c.extractDate) ||
    !revision(c.style) ||
    !revision(c.deployment) ||
    !object(c.sources) ||
    !keys(c.sources, ["osm", "overture"]) ||
    !revision(c.sources.osm) ||
    !revision(c.sources.overture) ||
    !object(c.provider) ||
    !keys(c.provider, ["id", "capabilities"]) ||
    !text(c.provider.id) ||
    !Array.isArray(c.provider.capabilities) ||
    !c.provider.capabilities.every(text)
  )
    return fail();
  const config = c.configuration;
  if (
    !object(config) ||
    !keys(config, ["language", "theme", "viewport", "dpr"]) ||
    !text(config.language) ||
    typeof config.theme !== "string" ||
    !["light", "dark"].includes(config.theme) ||
    !pair(config.viewport, false) ||
    typeof config.dpr !== "number" ||
    !Number.isFinite(config.dpr) ||
    config.dpr <= 0
  )
    return fail();
  if (!Array.isArray(value.observations)) return fail();
  const identities = new Set<string>();
  for (const o of value.observations) {
    if (
      !object(o) ||
      !keys(o, ["caseId", "layer", "stage", "kind", "cache", "results", "measurements"]) ||
      !REVIEWED_CASES.some((entry) => entry.id === o.caseId) ||
      !LAYERS.includes(o.layer as Layer) ||
      typeof o.stage !== "string" ||
      !(STAGES[o.layer as Layer] as readonly string[]).includes(o.stage) ||
      typeof o.kind !== "string" ||
      !["live", "recorded", "synthetic"].includes(o.kind) ||
      typeof o.cache !== "string" ||
      !["cold", "warm", "uncontrolled"].includes(o.cache) ||
      (o.cache !== "uncontrolled" && c.cacheIsolation !== "isolated") ||
      !Array.isArray(o.results) ||
      !o.results.every(
        (r) =>
          object(r) &&
          keys(r, ["label", "coordinates", "closed"]) &&
          text(r.label) &&
          pair(r.coordinates) &&
          typeof r.closed === "boolean",
      ) ||
      !object(o.measurements) ||
      !keys(o.measurements, ["requests", "latencyMs", "usefulLabels", "overlaps"]) ||
      !Object.values(o.measurements).every(
        (n) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0),
      )
    )
      return fail();
    if (
      [o.measurements.requests, o.measurements.usefulLabels, o.measurements.overlaps].some(
        (n) => n !== null && !Number.isInteger(n),
      )
    )
      return fail();
    const id = `${o.caseId}/${o.layer}`;
    if (identities.has(id)) return fail();
    identities.add(id);
  }
  return structuredClone(value) as unknown as Manifest;
}
export function assessObservation(entry: ReviewedCase, observation: Observation) {
  if (entry.id !== observation.caseId) throw new Error("Mismatched discovery case");
  const browsing = entry.id.startsWith("browsing/");
  const labelMatches = (a: string, b: string) =>
    a.toLocaleLowerCase("en").includes(b.toLocaleLowerCase("en"));
  const matches = (r: Observation["results"][number], e: Entity) =>
    [e.label, ...(e.aliases ?? [])].some((label) => labelMatches(r.label, label)) &&
    haversineDistance(r.coordinates, e.coordinates) <= e.radiusMeters;
  const required = entry.entities.filter((e) => e.disposition === "required");
  const excluded = entry.entities.filter((e) => e.disposition === "excluded");
  const ranks = required.map((e) => {
    const i = observation.results.findIndex((r) => !r.closed && matches(r, e));
    return i < 0 ? null : i + 1;
  });
  const matched = required.filter(
    (_, i) => ranks[i] !== null && (browsing || (ranks[i] ?? Infinity) <= entry.budgets.maxRank),
  ).length;
  const duplicates = required.reduce(
    (n, e) => n + Math.max(0, observation.results.filter((r) => matches(r, e)).length - 1),
    0,
  );
  const wrongBranch = observation.results
    .slice(0, browsing ? 0 : 1)
    .filter(
      (r) =>
        required.some((e) => labelMatches(r.label, e.label)) &&
        !required.some((e) => matches(r, e)),
    ).length;
  const forbiddenHits = observation.results.filter(
    (r) => !r.closed && excluded.some((e) => matches(r, e)),
  ).length;
  const metrics = {
    recall: required.length ? matched / required.length : null,
    firstRank: browsing ? null : (ranks[0] ?? null),
    duplicates,
    wrongBranch,
    forbiddenHits,
    ...observation.measurements,
  };
  const b = entry.budgets;
  const failed =
    (metrics.recall !== null && metrics.recall < b.minimumRecall) ||
    duplicates > b.maxDuplicates ||
    wrongBranch > b.maxWrongBranch ||
    forbiddenHits > b.maxForbiddenHits ||
    (metrics.requests !== null && metrics.requests > b.maxRequests) ||
    (observation.cache !== "uncontrolled" &&
      metrics.latencyMs !== null &&
      metrics.latencyMs > (observation.cache === "cold" ? b.coldLatencyMs : b.warmLatencyMs)) ||
    (observation.layer === "presentation" &&
      entry.id.startsWith("browsing/") &&
      ((metrics.usefulLabels !== null && metrics.usefulLabels < b.minimumUsefulLabels) ||
        (metrics.overlaps !== null && metrics.overlaps > b.maxOverlaps)));
  const incomplete =
    entry.id.startsWith("browsing/") &&
    observation.layer === "presentation" &&
    (metrics.usefulLabels === null || metrics.overlaps === null);
  return {
    caseId: entry.id,
    layer: observation.layer,
    stage: observation.stage,
    kind: observation.kind,
    cache: observation.cache,
    status: failed ? "failed" : incomplete ? "unavailable" : "passed",
    metrics,
  };
}
export type Assessment = ReturnType<typeof assessObservation>;
export function compareAssessments(before: Assessment[], after: Assessment[]) {
  const changes: Array<{
    caseId: string;
    layer: Layer;
    metric: string;
    before: number | null;
    after: number | null;
  }> = [];
  for (const current of after) {
    const previous = before.find(
      (entry) =>
        entry.caseId === current.caseId &&
        entry.layer === current.layer &&
        entry.stage === current.stage,
    );
    if (!previous) continue;
    for (const metric of Object.keys(current.metrics) as Array<keyof Assessment["metrics"]>) {
      if (current.metrics[metric] !== previous.metrics[metric])
        changes.push({
          caseId: current.caseId,
          layer: current.layer,
          metric,
          before: previous.metrics[metric],
          after: current.metrics[metric],
        });
    }
  }
  return { changes };
}

function reviewedCase(id: string) {
  const entry = REVIEWED_CASES.find((item) => item.id === id);
  if (!entry) throw new Error("Invalid discovery case");
  return entry;
}
export function buildReviewedEvidence(manifest: Manifest | null) {
  const results = (manifest?.observations ?? []).map((observation) =>
    assessObservation(reviewedCase(observation.caseId), observation),
  );
  return {
    version: REVIEW_VERSION,
    definitionHash: createHash("sha256").update(JSON.stringify(REVIEWED_CASES)).digest("hex"),
    definitions: structuredClone(REVIEWED_CASES),
    manifest,
    results,
    unavailable: REVIEWED_CASES.flatMap((entry) =>
      LAYERS.filter(
        (layer) => !results.some((result) => result.caseId === entry.id && result.layer === layer),
      ).map((layer) => ({ caseId: entry.id, layer })),
    ),
  };
}
export type ReviewedEvidence = ReturnType<typeof buildReviewedEvidence>;
function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (object(value))
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, JSON.parse(stable(value[key]))]),
      ),
    );
  return JSON.stringify(value) ?? "null";
}
export function validReviewedEvidence(value: unknown): value is ReviewedEvidence {
  if (!object(value)) return false;
  try {
    const manifest = value.manifest === null ? null : readManifest(value.manifest);
    return stable(value) === stable(buildReviewedEvidence(manifest));
  } catch {
    return false;
  }
}
export function compareReviewedEvidence(before: ReviewedEvidence, after: ReviewedEvidence) {
  if (before.version !== after.version || before.definitionHash !== after.definitionHash)
    throw new Error("Incompatible reviewed case definitions or budgets");
  const contextChanged = stable(before.manifest?.context) !== stable(after.manifest?.context);
  const changedProviderInputs: string[] = [];
  const previous = before.manifest?.observations ?? [];
  const current = after.manifest?.observations ?? [];
  for (const observation of [...previous, ...current]) {
    if (!["data", "provider"].includes(observation.layer)) continue;
    const id = `${observation.caseId}/${observation.layer}`;
    const old = previous.find(
      (item) => item.caseId === observation.caseId && item.layer === observation.layer,
    );
    const next = current.find(
      (item) => item.caseId === observation.caseId && item.layer === observation.layer,
    );
    if (
      JSON.stringify(old?.results) !== JSON.stringify(next?.results) &&
      !changedProviderInputs.includes(id)
    )
      changedProviderInputs.push(id);
  }
  const captureConditionsChanged =
    stable(
      previous
        .map(({ caseId, layer, stage, kind, cache }) => ({ caseId, layer, stage, kind, cache }))
        .sort((a, b) => `${a.caseId}/${a.layer}`.localeCompare(`${b.caseId}/${b.layer}`)),
    ) !==
    stable(
      current
        .map(({ caseId, layer, stage, kind, cache }) => ({ caseId, layer, stage, kind, cache }))
        .sort((a, b) => `${a.caseId}/${a.layer}`.localeCompare(`${b.caseId}/${b.layer}`)),
    );
  const regressions = before.results
    .filter(
      (result) =>
        result.status === "passed" &&
        !after.results.some(
          (next) =>
            next.caseId === result.caseId &&
            next.layer === result.layer &&
            next.stage === result.stage &&
            next.status === "passed",
        ),
    )
    .map((result) => `${result.caseId}/${result.layer}`);
  const { changes } = compareAssessments(before.results, after.results);
  const lostMeasurements = changes
    .filter((change) => change.before !== null && change.after === null)
    .map((change) => `${change.caseId}/${change.layer}`);
  return {
    contextChanged,
    captureConditionsChanged,
    changedProviderInputs,
    regressions: [...new Set([...regressions, ...lostMeasurements])],
    changes,
  };
}
