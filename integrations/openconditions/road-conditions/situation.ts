import type {
  LocalizedText,
  RoadConditionEffect,
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionValidity,
} from "@openmapx/integration-framework";

type Rec = Record<string, unknown>;

const obj = (v: unknown): Rec | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
/** `{ [key]: v }` when `v` is a non-empty string, else nothing to spread. */
const strField = <K extends string>(key: K, v: unknown): Partial<Record<K, string>> => {
  const s = str(v);
  return s === undefined ? {} : ({ [key]: s } as Record<K, string>);
};
const records = (v: unknown): Rec[] =>
  Array.isArray(v) ? v.filter((item): item is Rec => obj(item) !== undefined) : [];

/** Drops the parser's own trace (source path and tokens); the host has no use for it. */
function hostEffect(effect: Rec, validity?: unknown): RoadConditionEffect {
  const { source: _source, ...rest } = effect;
  return (
    rest["validity"] === undefined && validity !== undefined ? { ...rest, validity } : rest
  ) as RoadConditionEffect;
}

/**
 * A situation's effects, its phases' among them. A phase effect without a
 * window of its own holds during its phase, so it takes the phase's.
 */
function effectsOf(record: Rec): RoadConditionEffect[] {
  const own = records(record["effects"]).map((e) => hostEffect(e));
  const phases = records(obj(record["details"])?.["phases"]);
  return [
    ...own,
    ...phases.flatMap((phase) =>
      records(phase["effects"]).map((e) => hostEffect(e, phase["validity"])),
    ),
  ];
}

function roadsOf(location: Rec): RoadConditionRoadRef[] | undefined {
  const roads = records(location["roads"]);
  if (!roads.length) return undefined;
  return roads.map((r) => ({
    ...strField("ref", r["ref"]),
    ...(r["name"] ? { name: r["name"] as LocalizedText } : {}),
    ...strField("class", r["class"]),
    ...strField("from", r["from"]),
    ...strField("to", r["to"]),
  }));
}

function validityOf(raw: Rec): RoadConditionValidity {
  const keys = ["start", "end", "estimatedEnd", "periods", "exceptions"] as const;
  return {
    status: raw["status"] as RoadConditionValidity["status"],
    ...Object.fromEntries(keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])),
  };
}

/**
 * One OpenConditions situation record as the host's `RoadConditionEvent`,
 * field for field. A record not yet placed (no geometry) cannot be shown or
 * routed: null.
 */
export function situationToRoadConditionEvent(
  record: Rec,
  provider = "",
): RoadConditionEvent | null {
  const location = obj(record["location"]) ?? {};
  const geometry = obj(location["geometry"]);
  if (geometry === undefined) return null;
  const provenance = obj(record["provenance"]) ?? {};
  const attribution = obj(provenance["attribution"]) ?? {};
  const freshness = obj(record["freshness"]) ?? {};
  const severity = obj(record["severity"]) ?? {};
  const evidence = obj(record["evidence"]);
  const direction = obj(location["direction"]);
  const roads = roadsOf(location);
  return {
    id: String(record["id"]),
    source: String(provenance["sourceId"]),
    provider,
    ...strField("groupId", record["groupId"]),
    kind: String(record["kind"]),
    type: String(record["type"]),
    ...strField("subtype", record["subtype"]),
    severity: {
      label: (str(severity["label"]) ?? "unknown") as RoadConditionEvent["severity"]["label"],
      ...(typeof severity["level"] === "number" ? { level: severity["level"] } : {}),
    },
    certainty: (str(record["certainty"]) ?? "unknown") as RoadConditionEvent["certainty"],
    temporality: (str(record["temporality"]) ?? "live") as RoadConditionEvent["temporality"],
    planned: record["planned"] === true,
    ...(record["headline"] ? { headline: record["headline"] as LocalizedText } : {}),
    ...(record["description"] ? { description: record["description"] as LocalizedText } : {}),
    geometry: geometry as unknown as RoadConditionEvent["geometry"],
    ...(roads ? { roads } : {}),
    ...(direction
      ? {
          direction: {
            value: String(direction["value"]),
            ...strField("compass", direction["compass"]),
            ...strField("text", direction["text"]),
          },
        }
      : {}),
    validity: validityOf(obj(record["validity"]) ?? { status: "unknown" }),
    effects: effectsOf(record),
    origin: (str(provenance["origin"]) ?? "feed") as RoadConditionEvent["origin"],
    ...(evidence
      ? {
          evidence: {
            state: String(evidence["state"]),
            ...(typeof evidence["confidenceScore"] === "number"
              ? { confidenceScore: evidence["confidenceScore"] }
              : {}),
            ...(typeof evidence["routingEligible"] === "boolean"
              ? { routingEligible: evidence["routingEligible"] }
              : {}),
          },
        }
      : {}),
    attribution: {
      provider: str(attribution["provider"]) ?? String(provenance["sourceId"]),
      ...strField("license", attribution["license"]),
      ...strField("url", str(attribution["licenseUrl"]) ?? attribution["url"]),
    },
    ...strField("updatedAt", provenance["sourceUpdatedAt"]),
    fetchedAt: String(freshness["fetchedAt"]),
    ...strField("expiresAt", freshness["expiresAt"]),
  };
}
