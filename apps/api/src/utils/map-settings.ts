import type { HostedBasemapProvider } from "@openmapx/core/map-config";
import { processLogger } from "../process-logger";
import { resolveSetting, SecretSettingUnreadableError } from "../services/settings";

interface MapSettings {
  hostedBasemapProvider: HostedBasemapProvider;
  maptilerApiKey: string;
}
let cached: { value: MapSettings; expires: number } | undefined;
let pending: Promise<MapSettings> | undefined;
let generation = 0;
let warnedUnreadableKey = false;

export function invalidateMapSettings(): void {
  generation++;
  cached = undefined;
  pending = undefined;
}

async function resolveMapSettings(): Promise<MapSettings> {
  let provider: unknown;
  try {
    provider = await resolveSetting("basemap.provider");
  } catch {
    // Environment/default configuration remains usable during database outages.
    provider = await resolveSetting("basemap.provider", { database: null });
  }
  let maptilerApiKey: unknown;
  try {
    maptilerApiKey = await resolveSetting("maptiler.apiKey");
  } catch (err) {
    // The map keeps working without the stored key. An unusable key is
    // logged once per process, not on every cache refill.
    if (err instanceof SecretSettingUnreadableError && !warnedUnreadableKey) {
      warnedUnreadableKey = true;
      processLogger.warn({ component: "map-settings", err }, "The stored MapTiler key is unusable");
    }
    maptilerApiKey = await resolveSetting("maptiler.apiKey", { database: null });
  }
  return {
    hostedBasemapProvider: provider as HostedBasemapProvider,
    maptilerApiKey: (maptilerApiKey as string).trim(),
  };
}

export async function loadMapSettings(): Promise<MapSettings> {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (pending) return pending;
  const version = generation;
  const request = resolveMapSettings().then((value) => {
    if (version === generation) cached = { value, expires: Date.now() + 10_000 };
    return value;
  });
  pending = request;
  try {
    return await request;
  } finally {
    if (pending === request) pending = undefined;
  }
}
