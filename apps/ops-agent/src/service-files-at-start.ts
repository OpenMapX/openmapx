import { join, resolve } from "node:path";
import { services } from "@openmapx/core/server";

/**
 * What the agent's log says about the service files when it starts. After a
 * panel self-update the agent starts from the generation its predecessor
 * rendered, which mounts the checkout's files and records none of its own:
 * that is expected, and the next render (the update's own) takes the
 * release's. Never throws: an unusable override fails that render instead.
 */
export function describeServiceFilesAtStart(
  infraDir: string,
  // Under OPENMAPX_RELEASE=local none: the checkout's files are the release's.
  release: services.ReleaseServiceFiles | null = services.renderedEmbeddedReleaseServiceFiles(),
): string[] {
  if (!release) return [];
  const lines: string[] = [];
  try {
    const revisionId = services.currentConfigurationGeneration(infraDir);
    const recorded =
      revisionId !== null &&
      services.readGenerationServiceFiles(
        join(infraDir, services.CONFIGURATION_GENERATIONS, revisionId),
      ) !== null;
    if (revisionId !== null && !recorded) {
      lines.push(
        "The applied configuration was rendered by an earlier release, whose services mount their files from the checkout. The next render mounts this release's files instead.",
      );
    }
    if (!services.serviceFilesImported(infraDir)) {
      const position = services.checkoutPositionFromHistory(resolve(infraDir, "..", ".."), release);
      lines.push(
        position.atOrBehindRelease
          ? "The next render imports, once, your edits in the checkout's service files as overrides in infra/docker/overrides/services."
          : services.describeDeferredServiceFileImport(position.reason, []),
      );
    }
    const overrides = services.readServiceOverrides(infraDir, release);
    lines.push(
      ...services.describeServiceFiles({
        infraDir,
        services: [],
        release,
        overrides,
        stale: services.staleOverrides(infraDir, overrides, { record: false }),
      }),
    );
    return lines;
  } catch (error) {
    return [...lines, (error as Error).message];
  }
}
