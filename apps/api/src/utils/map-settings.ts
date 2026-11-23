import { type HostedBasemapProvider, hostedBasemapProviderSchema } from "@openmapx/core/map-config";
import { envString } from "@openmapx/core/server-env";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { processLogger } from "../process-logger";
import { isSecretSetting, loadSecretSettings } from "../services/settings";
import { resolveSettingPrecedence } from "./settings-resolution";

interface MapSettings {
  hostedBasemapProvider: HostedBasemapProvider;
  maptilerApiKey: string;
}
let cached: { values: Record<string, unknown>; expires: number } | undefined;
let pending: Promise<Record<string, unknown>> | undefined;
let generation = 0;
let warnedUnreadableKey = false;

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
    let values: Record<string, unknown>;
    try {
      const rows = await db.select().from(systemSettings);
      values = Object.fromEntries(
        rows.filter((row) => !isSecretSetting(row.key)).map((row) => [row.key, row.value]),
      );
    } catch {
      // Environment/default configuration remains usable during database outages.
      return {};
    }
    // The stored key is decrypted only when MAPTILER_KEY does not override it.
    if (!process.env.MAPTILER_KEY?.trim()) {
      try {
        const secrets = await loadSecretSettings(["maptilerApiKey"]);
        if (secrets.maptilerApiKey !== undefined) values.maptilerApiKey = secrets.maptilerApiKey;
      } catch (err) {
        // The map keeps working without the stored key. The reason is logged
        // once per process, not on every cache refill.
        if (!warnedUnreadableKey) {
          warnedUnreadableKey = true;
          processLogger.warn(
            { component: "map-settings", err },
            "The stored MapTiler key is unusable",
          );
        }
      }
    }
    if (version === generation) cached = { values, expires: Date.now() + 10_000 };
    return values;
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
    maptilerApiKey: envString("MAPTILER_KEY", databaseKey).trim(),
  };
}
