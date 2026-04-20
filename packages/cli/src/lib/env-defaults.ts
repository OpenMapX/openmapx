export const OPENMAPX_REGION_ENV = "OPENMAPX_REGION";
export const TRANSITOUS_COUNTRIES_ENV = "TRANSITOUS_COUNTRIES";

const SERVICE_REGION_ENVS: Record<string, string> = {
  motis: "MOTIS_REGION",
  osrm: "OSRM_REGION",
  otp: "OTP_REGION",
  overpass: "OVERPASS_REGION",
  pelias: "PELIAS_REGION",
  tileserver: "TILESERVER_REGION",
};

export interface ResolvedEnvDefault {
  value?: string;
  sourceEnv?: string;
}

export interface ResolvedListEnvDefault {
  values: string[];
  sourceEnv?: string;
}

function normalizeScalar(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveFromEnvNames(names: string[], env: NodeJS.ProcessEnv): ResolvedEnvDefault {
  for (const name of names) {
    const value = normalizeScalar(env[name]);
    if (value) return { value, sourceEnv: name };
  }
  return {};
}

export function serviceRegionEnvVar(serviceId: string): string | undefined {
  return SERVICE_REGION_ENVS[serviceId];
}

export function resolveRegionFromEnv(
  explicit: string | undefined,
  envNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvDefault {
  const direct = normalizeScalar(explicit);
  if (direct) return { value: direct };
  return resolveFromEnvNames(envNames, env);
}

export function resolveBuildRegion(
  serviceId: string,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvDefault {
  const envNames = [serviceRegionEnvVar(serviceId), OPENMAPX_REGION_ENV].filter(
    (name): name is string => Boolean(name),
  );
  return resolveRegionFromEnv(explicit, envNames, env);
}

export function resolveOsmRegion(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvDefault {
  return resolveRegionFromEnv(explicit, [OPENMAPX_REGION_ENV], env);
}

export function resolveOverpassRegion(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnvDefault {
  return resolveRegionFromEnv(explicit, ["OVERPASS_REGION", OPENMAPX_REGION_ENV], env);
}

export function resolveTransitousCountries(
  explicitCsv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedListEnvDefault {
  if (explicitCsv !== undefined) {
    return { values: parseCsvList(explicitCsv) };
  }

  const envValue = normalizeScalar(env[TRANSITOUS_COUNTRIES_ENV]);
  if (!envValue) return { values: [] };
  return {
    values: parseCsvList(envValue),
    sourceEnv: TRANSITOUS_COUNTRIES_ENV,
  };
}
