export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}
