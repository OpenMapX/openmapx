/** Reuse canonical checked data from the agent's own release store. */
import { services } from "@openmapx/core/server";
export function readCheckedConfigurationRelease(
  infraDir: string,
  input: { releaseId: string; manifestDigest: string },
) {
  return services.readCheckedConfigurationRelease(
    infraDir,
    input,
    services.readAppliedReleaseSelection(infraDir),
  );
}
export type CheckedConfigurationRelease = ReturnType<typeof readCheckedConfigurationRelease>;
