import { lstatSync } from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";

/**
 * The named volumes the API keeps its own data in (see services/app-api), as
 * Compose names them in the stack's project.
 */
export const API_VOLUMES = {
  subjectExports: `${services.STACK_PROJECT}_openmapx-subject-exports`,
  runtimeRecovery: `${services.STACK_PROJECT}_openmapx-api-runtime-recovery`,
} as const;

/**
 * The private directory the API keeps in one of its named volumes (subject
 * exports, the runtime-recovery journal), for whichever uid Compose runs it as.
 *
 * Docker seeds a new volume with the owner and mode of the image's directory.
 * This image's are root-owned, world-writable and sticky, like /tmp, so the
 * API uses `<mount>/uid-<uid>`, which its store creates 0700. A volume an
 * earlier image seeded belongs to uid 1000 with mode 0700; an API running as
 * that uid keeps using its root, and the data in it. A root that belongs to
 * another uid was seeded for another user. It is refused with the fix, which
 * keeps its data: the subject-export ciphertexts the database references and
 * the runtime-recovery journal.
 */
export function privateVolumeDirectory(mount: string, volume: string): string {
  const uid = process.geteuid?.();
  if (uid === undefined) return mount;
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(mount);
  } catch (error) {
    // Outside the container (development, tests): the store creates it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return mount;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${mount} must be a directory`);
  }
  if (stats.uid === uid) return mount;
  if (stats.uid === 0 && (stats.mode & 0o1777) === 0o1777) return join(mount, `uid-${uid}`);
  const gid = process.getegid?.() ?? uid;
  throw new Error(
    `${mount} (volume ${volume}) belongs to uid ${stats.uid} (mode ${(stats.mode & 0o7777).toString(8)}), not to uid ${uid}, which the API runs as: an earlier image created the volume for that uid. Keep its data and change its owner in place: stop app-api (pnpm openmapx services stop app-api), run \`docker run --rm -v ${volume}:/v alpine chown -R ${uid}:${gid} /v\`, and start app-api again`,
  );
}
