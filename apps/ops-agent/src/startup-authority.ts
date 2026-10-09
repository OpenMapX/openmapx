import { services } from "@openmapx/core/server";

/**
 * The services the operator's selection enables, for the time before the
 * first configuration generation is applied.
 */
export function resolveBootstrapEnabledServiceIds(
  loadedServices: readonly services.LoadedService[],
  desired: services.DesiredSelection,
): ReadonlySet<string> {
  const expanded = services.expandServiceSelection([...loadedServices], desired.roots, {
    allowMissingSelected: desired.source === "default",
  });
  if (expanded.missingIds.length > 0) {
    throw new Error("Service selection rejected");
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
