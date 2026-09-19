/**
 * Sign colours per country. Real-sign colours, deliberately constant per
 * country (real signs are not themed). Countries without an entry — and an
 * unknown or absent country — use the EU default: blue motorway shields, a
 * yellow primary-route shield, green European routes.
 */

export interface SignColors {
  bg: string;
  fg: string;
}

export interface SignPalette {
  motorway: SignColors;
  primary: SignColors;
  /** The exit-number badge in the banner strip. */
  exitBadge: SignColors;
  european: SignColors;
}

const WHITE = "#ffffff";
const BLACK = "#000000";
const GREEN = { bg: "#006b3f", fg: WHITE };

const DEFAULT_EU: SignPalette = {
  motorway: { bg: "#154889", fg: WHITE },
  primary: { bg: "#f4c542", fg: BLACK },
  exitBadge: { bg: "#154889", fg: WHITE },
  european: { bg: "#0b7a3b", fg: WHITE },
};

/** Green-on-white motorway signage, North American style. */
const ALL_GREEN: SignPalette = {
  motorway: GREEN,
  primary: GREEN,
  exitBadge: GREEN,
  european: GREEN,
};

/** Countries whose signs differ from the EU default. */
const OVERRIDES: Record<string, SignPalette> = {
  // Swiss motorways are green.
  CH: { ...DEFAULT_EU, motorway: GREEN, exitBadge: GREEN },
  // British primary routes are green; motorways stay blue.
  GB: { ...DEFAULT_EU, primary: GREEN },
  US: ALL_GREEN,
  CA: ALL_GREEN,
};

export function signPalette(countryCode: string | null): SignPalette {
  return (countryCode && OVERRIDES[countryCode.toUpperCase()]) || DEFAULT_EU;
}
