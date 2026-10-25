import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { API_VOLUMES, privateVolumeDirectory } from "./private-volume-directory";
import {
  openRuntimeRecoveryJournal,
  type RuntimeRecoveryJournal,
} from "./runtime-recovery-journal";

type OpenJournal = (
  path: string,
  options: { forbiddenServiceIds: Iterable<string> },
) => Promise<RuntimeRecoveryJournal>;

export async function openRuntimeRecoveryAuthority(
  rootDir: string,
  dependencies: {
    validateAuthority?: typeof services.validateReleaseServiceAuthority;
    openJournal?: OpenJournal;
  } = {},
): Promise<RuntimeRecoveryJournal> {
  const forbiddenServiceIds = [
    ...services.RELEASE_BUILT_IN_SERVICE_IDS,
    ...services.RELEASE_NEVER_MANAGE_SERVICE_IDS,
  ];
  await (dependencies.validateAuthority ?? services.validateReleaseServiceAuthority)(rootDir);
  return (dependencies.openJournal ?? openRuntimeRecoveryJournal)(
    join(
      privateVolumeDirectory(
        join(rootDir, "infra", "docker", ".runtime-recovery"),
        API_VOLUMES.runtimeRecovery,
      ),
      "runtime-recovery-v1.json",
    ),
    { forbiddenServiceIds },
  );
}
