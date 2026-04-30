import { expandPresets, UnknownPresetError } from "./presets";

/**
 * Merge `--services` and `--preset` flag values into the `string[]` shape the
 * renderer expects. Either flag (or both) may be present; both are
 * comma/space-separated. Returns `undefined` when neither was supplied so the
 * caller falls back to its default selection.
 *
 * Throws `UnknownPresetError` for unknown preset names — the caller logs the
 * available list and exits non-zero.
 */
export function combineServiceSelection(
  services: string | undefined,
  preset: string | undefined,
): string[] | undefined {
  const out: string[] = [];
  if (services) out.push(services);
  if (preset) out.push(...expandPresets([preset]));
  return out.length > 0 ? out : undefined;
}

export { UnknownPresetError };
