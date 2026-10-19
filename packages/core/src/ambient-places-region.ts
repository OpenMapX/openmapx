/** Region identities and validation shared by ambient jobs and wire contracts. */
export interface AmbientRegion {
  name: string;
  bounds: [number, number, number, number];
  coverage?: "germany" | "planet";
}
export const AMBIENT_GERMANY_REGION: AmbientRegion = {
  name: "Germany",
  bounds: [5.8, 47.2, 15.1, 55.1],
  coverage: "germany",
};
export const AMBIENT_PLANET_REGION: AmbientRegion = {
  name: "Planet",
  bounds: [-180, -85.051129, 180, 85.051129],
  coverage: "planet",
};
export const AMBIENT_GENERATION_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
export function validateAmbientRegion(value: unknown): AmbientRegion {
  const region = value as AmbientRegion;
  const b = region?.bounds;
  const preset =
    region?.coverage === "germany"
      ? AMBIENT_GERMANY_REGION
      : region?.coverage === "planet"
        ? AMBIENT_PLANET_REGION
        : null;
  if (
    typeof region?.name !== "string" ||
    !region.name.trim() ||
    region.name.length > 80 ||
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[0] < -180 ||
    b[2] > 180 ||
    b[1] < -85.051129 ||
    b[3] > 85.051129 ||
    b[2] <= b[0] ||
    b[3] <= b[1] ||
    (region.coverage !== undefined && !preset) ||
    (preset ? !b.every((v, i) => v === preset.bounds[i]) : b[2] - b[0] > 0.5 || b[3] - b[1] > 0.5)
  )
    throw new Error(
      "Choose the exact Germany/planet preset or an ordered world region no wider or higher than 0.5 degrees",
    );
  return {
    name: region.name.trim(),
    bounds: [...b],
    ...(preset ? { coverage: preset.coverage } : {}),
  };
}
