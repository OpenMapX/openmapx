export function envString(
  name: string,
  fallback: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[name];
  return value != null && value.trim() !== "" ? value : fallback;
}

export function envInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
