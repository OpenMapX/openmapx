/**
 * Named groups of service ids for the `--preset` flag on services start/stop/
 * restart/update and compose render/up. Lets operators say "start the
 * routing stack" instead of memorising which 4–10 ids belong together.
 *
 * When a service is added or removed from a preset, update both the entry
 * here and the README's deployment-preset section if applicable. The renderer
 * still expands dependencies (depends_on, consumed producers), so each preset
 * only needs to list the *root* services the operator wants — postgis, redis,
 * data-manager, traefik, etc. follow automatically.
 */
export const PRESETS: Record<string, readonly string[]> = {
  app: ["app-api", "app-web", "well-known"],
  proxy: ["traefik"],
  routing: ["osrm", "valhalla"],
  transit: ["motis", "motis-feed-proxy", "otp"],
  pelias: ["pelias", "pelias-pip", "pelias-placeholder", "elasticsearch"],
  nominatim: ["nominatim"],
  photon: ["photon"],
  overpass: ["overpass"],
  tiles: ["tileserver"],
  martin: ["martin"],
  dev: ["postgis", "redis"],
};

export type PresetName = keyof typeof PRESETS;

export class UnknownPresetError extends Error {
  readonly name = "UnknownPresetError";
  constructor(
    readonly preset: string,
    readonly available: string[],
  ) {
    super(`Unknown preset "${preset}". Available presets: ${available.join(", ")}`);
  }
}

/**
 * Expand `--preset` flag values into a flat list of service ids. Returns ids
 * in stable preset-declaration order with no de-duplication; the caller's
 * service-selection logic already de-dupes via `normalizeServiceIds`.
 *
 * Throws `UnknownPresetError` for any unknown preset name so the CLI can
 * surface the available list before invoking docker.
 */
export function expandPresets(presetNames: Iterable<string>): string[] {
  const out: string[] = [];
  const available = Object.keys(PRESETS);
  for (const raw of presetNames) {
    for (const token of raw.split(/[,\s]+/)) {
      const name = token.trim();
      if (!name) continue;
      const ids = PRESETS[name];
      if (!ids) throw new UnknownPresetError(name, available);
      out.push(...ids);
    }
  }
  return out;
}
