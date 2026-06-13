const COORD_SHAPE_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

// Geocoding runs in parallel regardless, so residual misclassification only
// costs an extra parse call, never a wrong result.
const NL_SIGNALS: RegExp[] = [
  /^(where|find|show|is there|what|which|any)\b/i,
  // Kept: unambiguous adjectives. Removed: good/nice/best (appear in real place names).
  /\b(quiet|cheap|cozy|romantic|accessible|wheelchair)\b/i,
  /\b(near|close to|within|around|next to|by the|between)\b/i,
  /\b(open now|open late|open on|24 ?hour|open sunday|open monday)\b/i,
  /\b(with(out)?|vegan|vegetarian|gluten.?free|halal|kosher)\b/i,
  /\b(and|or)\b.*\b(cafe|bar|shop|restaurant|coffee)\b/i,
  /\b(charge my|get coffee|eat lunch|grab a)\b/i,
  // German signals — the app ships en+de and users in DE type German queries
  // (e.g. "Schulen in meiner Nähe"). Kept precise to avoid matching place names.
  /^(wo|finde|zeige?|gibt es|welche[rsn]?|suche)\b/i,
  /\b(ruhig|günstig|guenstig|billig|gemütlich|gemuetlich|romantisch|barrierefrei|rollstuhlgerecht)\b/i,
  /\b(in (der|meiner) n[äa]he|n[äa]he|umgebung|umkreis|nahegelegen|in der umgebung)\b/i,
  /\b(jetzt geöffnet|jetzt geoeffnet|geöffnet|geoeffnet|rund um die uhr|24 ?stunden|heute geöffnet)\b/i,
  /\b(mit|ohne|vegan|vegetarisch|glutenfrei|halal|koscher)\b/i,
  /\b(und|oder)\b.*\b(café|cafe|bar|laden|geschäft|geschaeft|restaurant|kneipe|bäckerei)\b/i,
];

export function classifyQuery(query: string): "nl" | "geocode" | "coordinate" {
  const q = query.trim();
  const coordMatch = COORD_SHAPE_RE.exec(q);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return "coordinate";
  }
  if (NL_SIGNALS.some((re) => re.test(q))) return "nl";
  return "geocode";
}
