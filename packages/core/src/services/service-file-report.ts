import { resolve } from "node:path";
import {
  type ContainerBindMounts,
  containersOnCheckoutServiceFiles,
  describeContainersOnCheckoutServiceFiles,
} from "./container-mounts";
import type { ReleaseServiceFiles } from "./release-service-files";
import {
  describeServiceFileImport,
  describeUnusedCheckoutEdits,
  type ServiceFileImport,
  serviceFilesImported,
  unusedCheckoutEdits,
} from "./service-file-import";
import {
  type ActiveOverride,
  describeServiceOverrides,
  overrideOverlay,
  type ServiceOverrides,
} from "./service-overrides";
import type { LoadedService } from "./types";

/**
 * What render's output, the agent's log, `check` and Run diagnostics say
 * about the service files: the import, once, or why it waits; the overrides in use, those
 * whose release file changed since and those ignored; checkout edits no
 * override carries; and containers still mounting the checkout's files.
 * Names only, never contents.
 */
export function describeServiceFiles(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  overrides: ServiceOverrides;
  stale: readonly ActiveOverride[];
  imported?: ServiceFileImport | null;
  mounts?: readonly ContainerBindMounts[];
}): string[] {
  const { infraDir, release, overrides } = options;
  const lines = [
    ...describeServiceFileImport(options.imported ?? null),
    ...describeServiceOverrides(overrides, options.stale),
  ];
  if (release.origin === "release" && serviceFilesImported(infraDir)) {
    lines.push(
      ...describeUnusedCheckoutEdits(
        unusedCheckoutEdits({
          infraDir,
          services: options.services,
          release,
          overrides: overrideOverlay(overrides).files,
        }),
      ),
    );
  }
  if (options.mounts) {
    lines.push(
      ...describeContainersOnCheckoutServiceFiles(
        containersOnCheckoutServiceFiles(resolve(infraDir, "..", ".."), options.mounts),
      ),
    );
  }
  return lines;
}
