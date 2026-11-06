/** Reuse canonical checked data while preserving legacy handoff read semantics. */
import { services } from "@openmapx/core/server";
import { readAgentHandoffFile, readAgentHandoffFromInfra } from "./agent-handoff";
export function readCheckedConfigurationRelease(
  infraDir: string,
  input: { releaseId: string; manifestDigest: string },
) {
  return services.readCheckedConfigurationRelease(
    infraDir,
    input,
    services.readAppliedReleaseSelection(infraDir),
    () =>
      readAgentHandoffFile(services.agentStatePaths(infraDir).handoff) ??
      readAgentHandoffFromInfra(infraDir),
  );
}
export type CheckedConfigurationRelease = ReturnType<typeof readCheckedConfigurationRelease>;
