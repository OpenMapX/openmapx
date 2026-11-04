/** Bounds apply before rendering or converter traversal; no network resources are resolved. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export function boundedImportText(text: string): boolean {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    return false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 64) return false;
    } else if (char === "}" || char === "]") depth--;
  }
  return true;
}
export function validImportedCollection(fc: GeoJSON.FeatureCollection): boolean {
  if (fc.features.length < 1 || fc.features.length > 10000) return false;
  let positions = 0;
  function position(value: unknown): value is GeoJSON.Position {
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      value.length > 3 ||
      !value.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      return false;
    return Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 && ++positions <= 100000;
  }
  function line(value: unknown, min: number): boolean {
    return Array.isArray(value) && value.length >= min && value.every(position);
  }
  function polygon(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (ring) =>
          line(ring, 4) && ring[0].every((n: number, i: number) => n === ring[ring.length - 1][i]),
      )
    );
  }
  function geometry(value: unknown, depth: number): boolean {
    if (!value || typeof value !== "object" || depth > 8) return false;
    const g = value as { type?: unknown; coordinates?: unknown; geometries?: unknown };
    switch (g.type) {
      case "Point":
        return position(g.coordinates);
      case "MultiPoint":
        return line(g.coordinates, 1);
      case "LineString":
        return line(g.coordinates, 2);
      case "MultiLineString":
        return (
          Array.isArray(g.coordinates) &&
          g.coordinates.length > 0 &&
          g.coordinates.every((l) => line(l, 2))
        );
      case "Polygon":
        return polygon(g.coordinates);
      case "MultiPolygon":
        return (
          Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(polygon)
        );
      case "GeometryCollection":
        return (
          Array.isArray(g.geometries) &&
          g.geometries.length > 0 &&
          g.geometries.every((g) => geometry(g, depth + 1))
        );
      default:
        return false;
    }
  }
  return fc.features.every(
    (f) =>
      f &&
      f.type === "Feature" &&
      (f.properties === null ||
        (typeof f.properties === "object" && !Array.isArray(f.properties))) &&
      geometry(f.geometry, 0),
  );
}
