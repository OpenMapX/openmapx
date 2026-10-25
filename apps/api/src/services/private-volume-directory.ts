import { lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * The private directory the API keeps in one of its named volumes (subject
 * exports, the runtime-recovery journal), for whichever uid Compose runs it as.
 *
 * Docker seeds a new volume with the owner and mode of the image's directory.
 * This image's are root-owned, world-writable and sticky, like /tmp, so the
 * API uses `<mount>/uid-<uid>`, which its store creates 0700. A volume an
 * earlier image seeded belongs to uid 1000 with mode 0700; an API running as
 * that uid keeps using its root, and the data in it. A root that belongs to
 * another uid was seeded for another user, and is refused with the fix.
 */
export function privateVolumeDirectory(mount: string): string {
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
  throw new Error(
    `${mount} belongs to uid ${stats.uid} (mode ${(stats.mode & 0o7777).toString(8)}), not to uid ${uid}, which the API runs as: its volume was created for another user. Stop app-api, remove that volume (docker volume rm), and start app-api again; the volume is recreated for this uid`,
  );
}
