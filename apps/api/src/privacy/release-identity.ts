/** Actual implementation owners, supplied by deployment configuration. A
 * deployment identifier is not an attributable human and cannot prove review
 * independence. Empty/malformed configuration leaves release approval closed. */
export function privacyImplementationActorIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const value = env.PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS;
  if (!value || value.length > 4096 || /[\r\n\t]/.test(value)) return [];
  const ids = value.split(",").map((id) => id.trim());
  if (ids.length > 32 || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(id)))
    return [];
  return [...new Set(ids)];
}
