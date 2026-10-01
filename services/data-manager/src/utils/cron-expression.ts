// Sentinel values that disable a cron entirely. Empty string is NOT one of
// them: compose injects `${VAR:-}` as "" when the operator hasn't set the var,
// and that must fall through to the built-in default (handled in
// pickCronExpression), not silently disable the schedule.
const DISABLED_SENTINELS = new Set(["disabled", "off", "false"]);

export function pickCronExpression(
  override: string | undefined,
  envName: string,
  fallback: string,
): string | null {
  const raw = override ?? process.env[envName];
  // Unset OR empty (compose `${VAR:-}`) → built-in default. Only an explicit
  // disable sentinel turns the schedule off.
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (DISABLED_SENTINELS.has(trimmed)) return null;
  return raw.trim();
}

/**
 * Opt-in variant of {@link pickCronExpression}: an unset OR empty value means
 * DISABLED (returns null), not a built-in default. Used for the auto-bump cron,
 * which stays off unless an operator sets a schedule — the pinned catalog is a
 * deliberate safety gate, so tracking upstream is an explicit choice.
 */
export function pickOptInCronExpression(
  override: string | undefined,
  envName: string,
): string | null {
  const raw = override ?? process.env[envName];
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim().toLowerCase();
  if (DISABLED_SENTINELS.has(trimmed)) return null;
  return raw.trim();
}
