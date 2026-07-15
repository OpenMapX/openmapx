import type { TransitSource } from "./types.js";

export const MOTIS_OPERATIONS_PROFILES = [
  "regional-assisted",
  "regional-sovereign",
  "planet",
] as const;

export type MotisOperationsProfileName = (typeof MOTIS_OPERATIONS_PROFILES)[number];

export interface MotisOperationsPolicy {
  profile: MotisOperationsProfileName;
  countries: string[];
  feedAllowList: string[];
  acquisition: TransitSource;
  artifactOrigins: string[];
  originDownloadsRequired: boolean;
  hostedRuntimeFallbackAllowed: boolean;
  osmInput?: string;
  gbfsSelection: "explicit-countries" | "explicit-feeds" | "allow-listed-batches";
  maxFeedCount: number;
  retentionGenerations: number;
  resourceEnvelope: {
    minimumMemoryGb: number;
    minimumCpu: number;
    minimumDiskGb: number;
    operatorCapacityRequired: boolean;
  };
  updateCadenceHours: number;
  experimental: boolean;
}

export interface ResolveOperationsProfileInput {
  profile?: string;
  countries?: string[];
  feedAllowList?: string[];
  source?: TransitSource;
  artifactBaseUrl?: string;
  osmInput?: string;
  confirmPlanet?: boolean;
  maxFeedCount?: number;
  retentionGenerations?: number;
  allowEmptyRegional?: boolean;
}

function normalized(values: string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)),
  ].sort();
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function artifactOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`Invalid Transitous artifact URL: ${url}`);
  }
}

export function resolveOperationsProfile(
  input: ResolveOperationsProfileInput,
): MotisOperationsPolicy {
  const profile = (input.profile ?? "regional-assisted") as MotisOperationsProfileName;
  if (!MOTIS_OPERATIONS_PROFILES.includes(profile)) {
    throw new Error(`Unsupported MOTIS operations profile: ${input.profile}`);
  }
  const countries = normalized(input.countries);
  const feedAllowList = normalized(input.feedAllowList);
  const source = input.source ?? (profile === "regional-assisted" ? "mirror" : "build");
  const origin = artifactOrigin(input.artifactBaseUrl);

  if (
    profile !== "planet" &&
    countries.length === 0 &&
    feedAllowList.length === 0 &&
    !input.allowEmptyRegional
  ) {
    throw new Error(
      `${profile} requires explicit countries or a feed allow-list; [] never means planet`,
    );
  }
  if (profile === "planet" && input.confirmPlanet !== true) {
    throw new Error("planet profile requires MOTIS_PLANET_CONFIRM=true");
  }
  if (profile === "regional-sovereign") {
    if (source !== "build") throw new Error("regional-sovereign requires origin build acquisition");
    if (origin?.includes("transitous.org")) {
      throw new Error("regional-sovereign prohibits Transitous artifact domains");
    }
  }

  const assisted = profile === "regional-assisted";
  const planet = profile === "planet";
  return {
    profile,
    countries,
    feedAllowList,
    acquisition: source,
    artifactOrigins: origin ? [origin] : assisted ? ["https://api.transitous.org"] : [],
    originDownloadsRequired: !assisted,
    hostedRuntimeFallbackAllowed: assisted,
    osmInput: input.osmInput?.trim() || undefined,
    gbfsSelection: planet
      ? "allow-listed-batches"
      : feedAllowList.length > 0
        ? "explicit-feeds"
        : "explicit-countries",
    maxFeedCount: positiveInteger(input.maxFeedCount, planet ? 10_000 : 500, "maxFeedCount"),
    retentionGenerations: positiveInteger(
      input.retentionGenerations,
      planet ? 3 : 2,
      "retentionGenerations",
    ),
    resourceEnvelope: {
      minimumMemoryGb: planet ? 64 : 16,
      minimumCpu: planet ? 8 : 4,
      minimumDiskGb: planet ? 500 : 40,
      operatorCapacityRequired: planet,
    },
    updateCadenceHours: planet ? 48 : 24,
    experimental: planet,
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveOperationsProfileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ResolveOperationsProfileInput> = {},
): MotisOperationsPolicy {
  const number = (name: string): number | undefined => {
    const value = Number(env[name]);
    return Number.isFinite(value) ? value : undefined;
  };
  return resolveOperationsProfile({
    profile: env.MOTIS_OPERATIONS_PROFILE,
    countries: csv(env.TRANSITOUS_COUNTRIES),
    feedAllowList: csv(env.MOTIS_FEED_ALLOW_LIST),
    source: (env.TRANSIT_SOURCE as TransitSource | undefined) ?? undefined,
    artifactBaseUrl: env.TRANSITOUS_ARTIFACT_BASE_URL,
    osmInput: env.MOTIS_OSM_REGION ?? env.MOTIS_OSM_FILE,
    confirmPlanet: env.MOTIS_PLANET_CONFIRM === "true",
    maxFeedCount: number("MOTIS_MAX_FEED_COUNT"),
    retentionGenerations: number("MOTIS_RETENTION_GENERATIONS"),
    ...overrides,
  });
}

export function publicOperationsPolicy(policy: MotisOperationsPolicy): MotisOperationsPolicy {
  return structuredClone(policy);
}
