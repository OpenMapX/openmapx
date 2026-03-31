import { type BoundingBox, ConfigurationError } from "@openmapx/core";
import type { OcmPoi, OcmReferenceData } from "./ocm-types.js";

const OCM_BASE = "https://api.openchargemap.io/v3";

function getApiKey(): string {
  const key = process.env.OPENCHARGEMAP_API_KEY;
  if (!key) throw new ConfigurationError("OPENCHARGEMAP_API_KEY is not configured");
  return key;
}

export async function searchOcm(
  bbox: BoundingBox,
  filters?: Record<string, unknown>,
): Promise<OcmPoi[]> {
  const key = getApiKey();

  const params = new URLSearchParams({
    output: "json",
    boundingbox: `(${bbox.south},${bbox.west}),(${bbox.north},${bbox.east})`,
    compact: "true",
    verbose: "false",
    maxresults: "500",
    key,
  });

  if (filters) {
    if (filters.connectorType) {
      params.set("connectiontypeid", String(filters.connectorType));
    }
    if (filters.usageType) {
      params.set("usagetypeid", String(filters.usageType));
    }
    if (filters.status) {
      params.set("statustypeid", String(filters.status));
    }
  }

  const url = `${OCM_BASE}/poi/?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`OCM API error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as OcmPoi[];
}

export async function getOcmDetail(id: string): Promise<OcmPoi | null> {
  const key = getApiKey();

  const params = new URLSearchParams({
    output: "json",
    chargepointid: id,
    verbose: "true",
    key,
  });

  const url = `${OCM_BASE}/poi/?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`OCM API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as OcmPoi[];
  return data[0] ?? null;
}

export async function getOcmReferenceData(): Promise<OcmReferenceData> {
  const key = getApiKey();

  const url = `${OCM_BASE}/referencedata/?key=${encodeURIComponent(key)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`OCM reference data error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as OcmReferenceData;
}
