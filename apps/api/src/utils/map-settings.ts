import { type HostedBasemapProvider, hostedBasemapProviderSchema } from "@openmapx/core/map-config";
import { envString } from "@openmapx/core/server-env";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { resolveSettingPrecedence } from "./settings-resolution";

interface MapSettings {
  hostedBasemapProvider: HostedBasemapProvider;
  maptilerApiKey: string;
}
let cached: { values: Record<string, unknown>; expires: number } | undefined;
let pending: Promise<Record<string, unknown>> | undefined;
let generation = 0;

export function invalidateMapSettings(): void {
  generation++;
  cached = undefined;
  pending = undefined;
}

async function databaseSettings(): Promise<Record<string, unknown>> {
  if (cached && cached.expires > Date.now()) return cached.values;
  if (pending) return pending;
  const version = generation;
  const request = (async () => {
    try {
      const rows = await db.select().from(systemSettings);
      const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      if (version === generation) cached = { values, expires: Date.now() + 10_000 };
      return values;
    } catch {
      // Environment/default configuration remains usable during database outages.
      return {};
    }
  })();
  pending = request;
  try {
    return await request;
  } finally {
    if (pending === request) pending = undefined;
  }
}

export async function loadMapSettings(): Promise<MapSettings> {
  const values = await databaseSettings();
  const provider = resolveSettingPrecedence({
    envValue: process.env.BASEMAP_PROVIDER,
    databaseValue: values.hostedBasemapProvider,
    defaultValue: "auto" as HostedBasemapProvider,
    parseEnv: (raw) => raw,
    validate: (value): value is HostedBasemapProvider =>
      hostedBasemapProviderSchema.safeParse(value).success,
  });
  const databaseKey = typeof values.maptilerApiKey === "string" ? values.maptilerApiKey.trim() : "";
  return {
    hostedBasemapProvider: provider.value,
    maptilerApiKey: envString(
      "MAPTILER_KEY",
      envString("NEXT_PUBLIC_MAPTILER_KEY", databaseKey),
    ).trim(),
  };
}
