import { services } from "@openmapx/core/server";

export function resolveBootstrapEnabledServiceIds(
  loadedServices: readonly services.LoadedService[],
  bakedSelection: string | undefined,
): ReadonlySet<string> {
  const selected = services.parseServiceIdList(bakedSelection);
  const usesDefault = selected === null;
  const expanded = services.expandServiceSelection(
    [...loadedServices],
    selected ?? services.DEFAULT_SELECTED_SERVICE_IDS,
    { allowMissingSelected: usesDefault },
  );
  if (expanded.missingIds.length > 0) {
    throw new Error("Baked service selection rejected");
  }
  return new Set(expanded.enabledIds);
}

export async function afterValidatedServiceAuthority<T>(
  rootDir: string,
  initialize: (authority: services.ReleaseServiceAuthorityCapture) => Promise<T>,
  validate: typeof services.captureReleaseServiceAuthority = services.captureReleaseServiceAuthority,
): Promise<T> {
  const authority = await validate(rootDir);
  return initialize(authority);
}
