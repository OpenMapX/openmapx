import z from "zod/v4";

// Semantic Versioning 2.0.0, without a leading "v".
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

interface ParsedSemver {
  core: [string, string, string];
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | null {
  if (value.length > 256) return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    core: [match[1] ?? "0", match[2] ?? "0", match[3] ?? "0"],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Order two digit strings without leading zeros numerically, at any length. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function isSemver(value: unknown): value is string {
  return typeof value === "string" && parseSemver(value) !== null;
}

/**
 * A component or extension version: Semantic Versioning 2.0.0, such as `1.4.0`
 * or `2.0.0-rc.1`. A pattern rather than a refinement, so the generated JSON
 * Schema carries it and an editor refuses `1.0` as the validator does.
 */
export const semverSchema = z
  .string()
  .max(256)
  .regex(SEMVER_PATTERN, "must be a semantic version such as 1.0.0");

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Semantic Versioning precedence: negative when `a` is older than `b`, zero
 * when equal (build metadata is ignored), positive when newer. Returns null
 * when either value is not a semantic version.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i] ?? "0", right.core[i] ?? "0");
    if (order !== 0) return order;
  }
  // A release outranks every pre-release of the same core version.
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const order = comparePrereleaseIdentifier(l, r);
    if (order !== 0) return order;
  }
  return 0;
}
