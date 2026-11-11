import { services as coreServices } from "@openmapx/core/server";
import { repoPaths } from "./paths";
import { selectedReleaseServiceFiles } from "./release-service-files";

/**
 * What `check` (and so Run diagnostics, which runs the agent's own check)
 * says about the service files, without changing anything: the overrides in
 * use, flagged and ignored, and, run from the checkout, what a host render
 * would refuse. Each entry is information when nothing needs doing, a
 * warning when something needs a look, or an error when render would fail
 * on it. In Run diagnostics information reaches the panel on the fixed
 * CLI's stdout, warnings and errors on its stderr.
 */
export async function serviceFileReport(): Promise<
  Array<{ level: "info" | "warn" | "err"; message: string }>
> {
  const paths = repoPaths();
  const lines: Array<{ level: "info" | "warn" | "err"; message: string }> = [];
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
  lines.push(
    ...coreServices.describeServiceFiles({
      release,
      overrides,
      stale: coreServices.staleOverrides(paths.infraDir, overrides, { record: false }),
    }),
  );
  if (selected && selected !== "none") {
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
        message: `A host render refuses until this is resolved. ${coreServices.describeCheckoutDifferences(
          differences,
          { name: selected.release, revision: selected.revision },
        )}`,
      });
    }
  }
  return lines;
}
