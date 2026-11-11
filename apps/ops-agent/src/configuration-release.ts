/** Reuse canonical checked data, reading the handoff record as the agent does. */
import { services } from "@openmapx/core/server";
import { readAgentHandoffFile } from "./agent-handoff";
export function readCheckedConfigurationRelease(
  infraDir: string,
  input: { releaseId: string; manifestDigest: string },
) {
  return services.readCheckedConfigurationRelease(
    infraDir,
    input,
    services.readAppliedReleaseSelection(infraDir),
    () => readAgentHandoffFile(services.agentStatePaths(infraDir).handoff),
  );
}
export type CheckedConfigurationRelease = ReturnType<typeof readCheckedConfigurationRelease>;
