import type { ReleaseServiceFiles } from "./release-service-files";
import {
  type ActiveOverride,
  describeServiceOverrides,
  type ServiceOverrides,
} from "./service-overrides";

/**
 * One line of the service file report. `info` says how things are when
 * nothing needs doing (the overrides in use); `warn` asks the operator to
 * look at something. Every surface keeps the level: render's output and
 * `check` log it at that level, the agent's log marks a warning with ⚠ as
 * the CLI does, and Run diagnostics shows the agent's `check` output,
 * warnings among its errors.
 */
export interface ServiceFileReportLine {
  level: "info" | "warn";
  message: string;
}

const info = (message: string): ServiceFileReportLine => ({ level: "info", message });

/** Said by a render under `OPENMAPX_RELEASE=local` that took the files built into the agent's image. */
export const SERVICE_FILES_BUILT_INTO_IMAGE =
  "Under OPENMAPX_RELEASE=local this operations agent rendered the service files built into its image, which a render on the host reads from the checkout's services/ instead. An edit made there since the image was built is not used here: rebuild the ops-agent image from the checkout and recreate the agent, or render on the host.";

/**
 * What render's output, the agent's log, `check` and Run diagnostics say
 * about the service files: where they came from under
 * `OPENMAPX_RELEASE=local`, and the overrides in use, those whose release
 * file changed since and those ignored. Names only, never contents.
 */
export function describeServiceFiles(options: {
  release: ReleaseServiceFiles;
  overrides: ServiceOverrides;
  stale: readonly ActiveOverride[];
}): ServiceFileReportLine[] {
  return [
    ...(options.release.builtIntoImage ? [info(SERVICE_FILES_BUILT_INTO_IMAGE)] : []),
    ...describeServiceOverrides(options.overrides, options.stale),
  ];
}
