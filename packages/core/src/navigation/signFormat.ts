import type { ManeuverSign } from "../types/routing";

/**
 * Sign classification for interchange signage rendering. Refs are the engine
 * strings (OSM style, e.g. "A 57", "E 35"); the kinds pick the shield palette.
 */

/** Kinds the web shield component maps to country palettes. */
export type RefKind = "motorway" | "federal" | "european" | "other";

/**
 * Classify one road ref by its leading designation. Alphabet prefixes are
 * space-optional on the continent; GB and US forms have their own shapes.
 */
export function refKind(ref: string): RefKind {
  if (/^A\s?\d/i.test(ref)) return "motorway";
  if (/^E\s?\d/i.test(ref)) return "european";
  if (/^B\s?\d/i.test(ref)) return "federal";
  if (/^M\d/i.test(ref)) return "motorway";
  if (/^I[- ]\d/i.test(ref)) return "motorway";
  return "other";
}

/** The toward destinations that fit in one strip (the spec's three-town cap). */
export function visibleToward(list: string[], max = 3): string[] {
  return list.slice(0, max);
}

/**
 * The headline texts for a sign: the toward destinations when present, else
 * the exit names. An engine exit name is usually the *next* interchange, not
 * this exit's title, so it must never be shown alongside a toward list.
 */
export function signHeadline(sign: ManeuverSign | undefined): string[] {
  if (sign?.exitToward?.length) return sign.exitToward;
  if (sign?.exitNames?.length) return sign.exitNames;
  return [];
}
