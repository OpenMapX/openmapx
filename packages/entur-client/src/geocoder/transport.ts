import type { ZodType } from "zod";
import type { EnturClient } from "../client";
import { EnturRequestError } from "../errors";
import { Result } from "./generated/models";

/** Internal generated-call context. The public facade never exposes request authority. */
export interface EnturGeocoderRequestOptions {
  client?: EnturClient;
  signal?: AbortSignal;
  method?: string;
  schema?: ZodType;
}

function normalizeRoles(value: unknown): unknown {
  if (
    !value ||
    typeof value !== "object" ||
    !("features" in value) ||
    !Array.isArray(value.features)
  )
    return value;
  return {
    ...value,
    features: value.features.map((feature: unknown) => {
      if (!feature || typeof feature !== "object" || !("properties" in feature)) return feature;
      const properties = feature.properties;
      if (!properties || typeof properties !== "object" || !("stopPlaceRole" in properties))
        return feature;
      const role = properties.stopPlaceRole;
      if (typeof role !== "string" || ["parent", "child", "standalone"].includes(role))
        return feature;
      const { stopPlaceRole: _role, ...rest } = properties;
      return { ...feature, properties: rest };
    }),
  };
}

export async function enturGeocoderRequest<T>(
  url: string,
  options?: EnturGeocoderRequestOptions,
): Promise<T> {
  if (
    !options?.client ||
    typeof options.client.getJson !== "function" ||
    !(options.signal instanceof AbortSignal) ||
    options.method !== "GET" ||
    options.schema !== Result ||
    !/^\/v3\/(autocomplete|reverse|place)(?:\?|$)/.test(url)
  )
    throw new EnturRequestError("config");
  const value = await options.client.getJson<unknown>("geocoder", url, options.signal);
  try {
    const result = Result.parse(normalizeRoles(value));
    for (const feature of result.features) {
      const [lon, lat] = feature.geometry.coordinates;
      if (
        lon === undefined ||
        lat === undefined ||
        !Number.isFinite(lon) ||
        !Number.isFinite(lat) ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90
      )
        throw new Error("coordinates");
    }
    return result as T;
  } catch {
    throw new EnturRequestError("response");
  }
}
