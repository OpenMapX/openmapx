import { services as coreServices } from "@openmapx/core/server";
import { containerBindMounts } from "./container-mounts";
import { repoPaths } from "./paths";
import { selectedReleaseServiceFiles } from "./release-service-files";

/**
 * What `check` (and so Run diagnostics, which runs the agent's own check)
 * says about the service files, without changing anything: the overrides in
 * use, flagged and ignored, an import still to run, unused checkout edits,
 * containers on the checkout's files, and, run from the checkout, what a
 * host render would refuse. Each entry is a warning, or an error when render
 * would fail on it.
 */
export async function serviceFileReport(): Promise<
  Array<{ level: "warn" | "err"; message: string }>
> {
  const paths = repoPaths();
  const lines: Array<{ level: "warn" | "err"; message: string }> = [];
  const registry = new coreServices.ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const services = registry.list();
  let release: coreServices.ReleaseServiceFiles;
  let selected: Awaited<ReturnType<typeof selectedReleaseServiceFiles>> = null;
  try {
    selected = await selectedReleaseServiceFiles(paths.infraDir);
    release =
      selected && selected !== "none" ? selected.files : coreServices.releaseServiceFiles(services);
  } catch (error) {
    return [{ level: "err", message: (error as Error).message }];
  }
  let overrides: ReturnType<typeof coreServices.readServiceOverrides>;
  try {
    overrides = coreServices.readServiceOverrides(paths.infraDir, release);
  } catch (error) {
    return [{ level: "err", message: (error as Error).message }];
  }
  if (release.origin === "release" && !coreServices.serviceFilesImported(paths.infraDir)) {
    lines.push({
      level: "warn",
      message:
        "The next render imports, once, your edits in the checkout's service files as overrides in infra/docker/overrides/services, and from then on uses the release's files.",
    });
  }
  const mounts = await containerBindMounts();
  for (const message of coreServices.describeServiceFiles({
    infraDir: paths.infraDir,
    services,
    release,
    overrides,
    stale: coreServices.staleOverrides(paths.infraDir, overrides, { record: false }),
    ...(mounts ? { mounts } : {}),
  })) {
    lines.push({ level: "warn", message });
  }
  if (selected && selected !== "none" && coreServices.serviceFilesImported(paths.infraDir)) {
    const differences = coreServices.checkoutDifferencesFromRelease({
      rootDir: paths.root,
      services,
      release,
      overrides: new Map(
        overrides.active.map((entry) => [`${entry.serviceId}/${entry.path}`, entry.bytes]),
      ),
    });
    if (differences.length > 0) {
      lines.push({
        level: "err",
        message: `A host render refuses until this is resolved. ${coreServices.describeCheckoutDifferences(differences, { name: selected.release, revision: selected.revision })}`,
      });
    }
  }
  return lines;
}
