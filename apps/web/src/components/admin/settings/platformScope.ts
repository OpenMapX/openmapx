import type { AdminPlatformPreview } from "@openmapx/core/api-contracts";
export type PlatformScope = "deployment" | "release" | "retention";
export type PlatformFieldName = keyof AdminPlatformPreview["values"];
export type PlatformConfigurationValue = AdminPlatformPreview["configuration"];
export type PlatformDraft = Partial<
  Record<PlatformFieldName, PlatformConfigurationValue[PlatformFieldName] | null>
>;
export const PLATFORM_SCOPE_FIELDS = {
  deployment: ["domain", "acmeEmail", "defaultRegion"],
  release: ["releaseSelector"],
  retention: ["backupRetentionDays"],
} as const satisfies Record<PlatformScope, readonly PlatformFieldName[]>;
export const PLATFORM_SCOPE_HREF = {
  deployment: "/admin/system/deployment",
  release: "/admin/system/updates",
  retention: "/admin/system/backups",
} as const;
export function buildPlatformCandidate(
  baseline: PlatformConfigurationValue,
  edits: PlatformDraft,
  scope: PlatformScope,
): PlatformConfigurationValue {
  const candidate = { ...baseline };
  for (const key of PLATFORM_SCOPE_FIELDS[scope])
    if (Object.hasOwn(edits, key) && edits[key] != null)
      Object.assign(candidate, { [key]: edits[key] });
  return candidate;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Every hidden ownership/value remains exactly as captured, even if the server normalizes input. */
export function platformPreviewWithinScope(
  preview: AdminPlatformPreview,
  baseline: Pick<AdminPlatformPreview, "configuration" | "values" | "sources">,
  candidate: PlatformConfigurationValue,
  scope: PlatformScope,
): boolean {
  const fields: readonly PlatformFieldName[] = PLATFORM_SCOPE_FIELDS[scope];
  for (const key of Object.keys(baseline.values) as PlatformFieldName[]) {
    if (fields.includes(key)) continue;
    if (
      !equal(preview.configuration[key], candidate[key]) ||
      !equal(preview.values[key], baseline.values[key]) ||
      !equal(preview.sources[key], baseline.sources[key])
    )
      return false;
  }
  if (scope !== "deployment" && preview.oldOrigin !== preview.newOrigin) return false;
  if (scope !== "release" && preview.release !== undefined) return false;
  return true;
}
