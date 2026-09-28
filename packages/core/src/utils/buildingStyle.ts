/** Identify building geometry using the provider's source schema or layer name.
 * Keep this shared by basemap sanitization and the controlled building overlay.
 * Generic structures/landmarks alone are deliberately not building evidence.
 */
export function isBuildingStyleLayer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const layer = value as Record<string, unknown>;
  if (!["fill", "line", "fill-extrusion"].includes(String(layer.type))) return false;
  if (typeof layer["source-layer"] !== "string") return false;
  return (
    /^(building|buildings)$/i.test(layer["source-layer"]) ||
    (typeof layer.id === "string" && /(?:^|[^a-z])buildings?(?:[^a-z]|$)/i.test(layer.id))
  );
}
