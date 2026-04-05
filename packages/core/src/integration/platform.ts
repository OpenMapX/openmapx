/**
 * The current platform version. Community integrations declare a minimum
 * compatible version via the `platform` field in their manifest.
 *
 * Uses semver-style "major.minor" versioning. Bump the major when breaking
 * changes are made to the integration API (IntegrationContext, domain
 * interfaces, manifest schema). Bump the minor for additive changes.
 */
export const PLATFORM_VERSION = "1.0";

/**
 * Check whether the current platform satisfies a community integration's
 * minimum version requirement. Uses simple major.minor comparison:
 * the current major must equal the required major, and the current minor
 * must be >= the required minor.
 */
export function satisfiesPlatformVersion(required: string): boolean {
  const [reqMajor, reqMinor = 0] = required.split(".").map(Number);
  const [curMajor, curMinor = 0] = PLATFORM_VERSION.split(".").map(Number);

  if (Number.isNaN(reqMajor) || Number.isNaN(curMajor)) return true;

  // Major version must match (breaking changes)
  if (curMajor !== reqMajor) return curMajor > reqMajor;
  // Minor must be >= required (additive changes)
  return curMinor >= reqMinor;
}
