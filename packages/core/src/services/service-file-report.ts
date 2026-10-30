import { resolve } from "node:path";
import { checkoutMountedAt } from "./checkout-layout";
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
 * One line of the service file report. `info` says how things are when
 * nothing needs doing (the overrides in use, the import that ran); `warn`
 * asks the operator to look at something. Every surface keeps the level:
 * render's output and `check` log it at that level, the agent's log marks a
 * warning with ⚠ as the CLI does, and Run diagnostics shows the agent's
 * `check` output, warnings among its errors.
 */
export interface ServiceFileReportLine {
  level: "info" | "warn";
  message: string;
}

const info = (message: string): ServiceFileReportLine => ({ level: "info", message });
const warn = (message: string): ServiceFileReportLine => ({ level: "warn", message });

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
}): ServiceFileReportLine[] {
  const { infraDir, release, overrides } = options;
  const imported = options.imported ?? null;
  // The import's own report: what it made overrides of, or why it waits.
  const importLevel = imported && "deferred" in imported ? warn : info;
  const lines = [
    ...describeServiceFileImport(imported).map(importLevel),
    ...describeServiceOverrides(overrides, options.stale),
  ];
  if (
    release.origin === "release" &&
    serviceFilesImported(infraDir) &&
    !checkoutMountedAt(infraDir)
  ) {
    lines.push(
      info(
        "The one-time import of your edits in the checkout's service files has run (infra/docker/state/ops-agent/overrides-import.json). This operations agent runs without the checkout, so it doesn't compare the checkout's service files with the release's; `pnpm openmapx check` on the host does.",
      ),
    );
  } else if (release.origin === "release" && serviceFilesImported(infraDir)) {
    lines.push(
      ...describeUnusedCheckoutEdits(
        unusedCheckoutEdits({
          infraDir,
          services: options.services,
          release,
          overrides: overrideOverlay(overrides).files,
        }),
      ).map(warn),
    );
  }
  if (options.mounts) {
    lines.push(
      ...describeContainersOnCheckoutServiceFiles(
        containersOnCheckoutServiceFiles(resolve(infraDir, "..", ".."), options.mounts),
      ).map(warn),
    );
  }
  return lines;
}
