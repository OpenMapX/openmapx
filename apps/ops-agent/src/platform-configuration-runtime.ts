/** Fixed original-owner protected handoff. Old images fail the explicit bundle
 * prerequisite before ownership; the installer does not advertise a helper. */
import { launchPreparedConfigurationHandoff } from "./configuration-handoff-store";
import type { OpsRuntime } from "./runtime";

export function installPlatformConfigurationRuntime(runtime: OpsRuntime): void {
  runtime["configurationHandoff.prepare"] = (operation, context) =>
    launchPreparedConfigurationHandoff(runtime, operation, context);
}
