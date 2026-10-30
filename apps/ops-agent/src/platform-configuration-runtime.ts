/** Fixed original-owner protected handoff. Old images fail the explicit bundle
 * prerequisite before ownership; the installer does not advertise a helper. */
import {
  inspectConfigurationHandoff,
  launchPreparedConfigurationHandoff,
} from "./configuration-handoff-store";
import type { OpsRuntime } from "./runtime";

export function installPlatformConfigurationRuntime(
  runtime: OpsRuntime,
  options: { infraDir: string },
): void {
  runtime["configurationHandoff.prepare"] = (operation, context) =>
    launchPreparedConfigurationHandoff(runtime, operation, context);
  runtime["configurationHandoff.inspect"] = async (operation) =>
    inspectConfigurationHandoff(options.infraDir, operation.handoffId);
}
