import type { TransportMode } from "../types/transit";

export const MODE_COLORS: Record<TransportMode, string> = {
  rail: "#1A73E8",
  subway: "#E53935",
  tram: "#F9A825",
  bus: "#0F9D58",
  ferry: "#00ACC1",
  gondola: "#8E24AA",
  funicular: "#8E24AA",
  cable_car: "#8E24AA",
  monorail: "#1A73E8",
  walking: "#757575",
};

export interface ProviderAttribution {
  label: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

/**
 * Pattern-based fallback for provider resolution.
 * Use `resolveProvider` in UI components that have the fetched providers map;
 * this is only a last-resort fallback when the map is unavailable.
 */
export function providerAttribution(provider: string): ProviderAttribution {
  if (provider.startsWith("gtfs-")) return { label: `GTFS (${provider.slice(5)})`, url: "" };
  return { label: provider, url: "" };
}

/**
 * Resolve a provider string using the fetched providers map first, then
 * falling back to the static table. Use this in components that call `useProviders()`.
 */
export function resolveProvider(
  providers: Record<string, ProviderAttribution>,
  id: string,
): ProviderAttribution {
  return providers[id] ?? providerAttribution(id);
}

/** Shorthand: resolve provider to display label only (static table only). */
export function providerLabel(provider: string): string {
  return providerAttribution(provider).label;
}
