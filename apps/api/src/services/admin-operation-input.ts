import { isAbsolute, relative, resolve } from "node:path";
import { findRepoRoot } from "@openmapx/core/server";
import { z } from "zod";
import { getServiceRegistry } from "./service-registry";

// Input-shape guards run before values become typed operation identifiers.
// The imperative variants serve the backup and bulk-service handlers; the zod
// variants serve the operation catalog. Both agree on the same shapes.

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/** Mirrors the ops-contract `regionIdSchema`, which the agent enforces. */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
/** Comma-separated ISO-3166 alpha-2/3 codes. */
export const COUNTRIES_RE = /^[a-zA-Z]{2,3}(,[a-zA-Z]{2,3})*$/;

export function rejectFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} must not begin with "-"`);
  }
}

export function assertSlug(value: string, label: string): void {
  rejectFlagLike(value, label);
  if (!SLUG_RE.test(value)) {
    throw new Error(`${label} must be a slug (alphanumeric, ".", "_", "-")`);
  }
}

export function assertRegion(value: string): void {
  rejectFlagLike(value, "region");
  if (value.includes("..") || !REGION_ID_RE.test(value)) {
    throw new Error(
      "region must be lowercase path segments such as europe/germany and contain no ..",
    );
  }
}

export function assertCountries(value: string): void {
  rejectFlagLike(value, "countries");
  if (!COUNTRIES_RE.test(value)) {
    throw new Error("countries must be a comma-separated list of ISO country codes");
  }
}

/** Throws unless `path` is absolute (or resolves to) inside the repo root. */
export function assertInsideRepo(path: string, label: string): string {
  rejectFlagLike(path, label);
  const root = findRepoRoot();
  const resolved = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must resolve to a path inside the repo root`);
  }
  return resolved;
}

/** Validates each id in `serviceIds` exists in the registry. Throws on first miss. */
export function assertKnownServiceIds(serviceIds: string[]): void {
  if (serviceIds.length === 0) return;
  let registry: ReturnType<typeof getServiceRegistry>;
  try {
    registry = getServiceRegistry();
  } catch {
    // Registry not initialized (cold start): fall back to the slug-shape
    // check only. This is the same posture the admin route takes.
    for (const id of serviceIds) assertSlug(id, "serviceId");
    return;
  }
  const known = new Set(registry.list().map((s) => s.manifest.id));
  for (const id of serviceIds) {
    assertSlug(id, "serviceId");
    if (!known.has(id)) {
      throw new Error(`Unknown serviceId: "${id}"`);
    }
  }
}

const REGION_MESSAGE = "Use lowercase path segments such as europe/germany";

export const regionSchema = z
  .string()
  .trim()
  .min(1, "Region is required")
  .max(128)
  .refine((value) => !value.startsWith("-"), 'Region must not begin with "-"')
  .refine((value) => !value.includes(".."), REGION_MESSAGE)
  .refine((value) => REGION_ID_RE.test(value), REGION_MESSAGE);

/** Blank input means "use the configured default region". */
export const optionalRegionSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  regionSchema.optional(),
);

export const slugSchema = z
  .string()
  .trim()
  .min(1, "Value is required")
  .max(128)
  .refine((value) => !value.startsWith("-"), 'Value must not begin with "-"')
  .refine((value) => SLUG_RE.test(value), 'Use letters, digits, ".", "_" or "-"');

/** `"de, at"` becomes `["DE", "AT"]`; blank input becomes `undefined`. */
export const countriesSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const compact = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(",");
    return compact === "" ? undefined : compact;
  },
  z
    .string()
    .max(256)
    .refine((value) => !value.startsWith("-"), 'Countries must not begin with "-"')
    .refine(
      (value) => COUNTRIES_RE.test(value),
      "Use comma-separated ISO country codes such as de,at,ch",
    )
    .transform((value) => value.toUpperCase().split(","))
    .optional(),
);
