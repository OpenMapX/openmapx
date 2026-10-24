import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const MAX_ENTRIES = 100_000;

/**
 * Removes group and other write from `custom_integrations/` and every
 * directory and regular file in it that `owner` owns, as the installer writes
 * them. Integrations installed before it fixed their modes, for example under
 * a umask of `002`, then load without being installed again.
 *
 * Each entry is opened without following a symbolic link and its mode changed
 * through that descriptor, so a link is never followed or changed. On Linux
 * the walk goes through the opened directories (`/proc/self/fd`), so a
 * directory swapped for a link during the walk is not entered either. Only
 * write bits are ever removed. An entry another account owns is left as it
 * is: the operations agent refuses to load it and reports it.
 */
export function tightenCustomIntegrations(
  rootDir: string,
  owner: number | undefined = process.geteuid?.(),
): void {
  if (owner === undefined) return;
  const anchored = existsSync("/proc/self/fd");
  let visited = 0;
  const visit = (path: string): void => {
    visited += 1;
    if (visited > MAX_ENTRIES) return;
    let fd: number;
    try {
      // Only directories and regular files are opened, never a device or FIFO.
      const entry = lstatSync(path);
      if (entry.uid !== owner || (!entry.isDirectory() && !entry.isFile())) return;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return; // A symbolic link (ELOOP), gone, or unreadable: left as it is.
    }
    try {
      const stats = fstatSync(fd);
      if (stats.uid !== owner || (!stats.isDirectory() && !stats.isFile())) return;
      if ((stats.mode & 0o022) !== 0) fchmodSync(fd, stats.mode & 0o7755);
      if (!stats.isDirectory()) return;
      const directory = anchored ? `/proc/self/fd/${fd}` : path;
      for (const name of readdirSync(directory)) visit(join(directory, name));
    } catch {
      // Best effort: whatever stays writable, the agent's check reports.
    } finally {
      closeSync(fd);
    }
  };
  visit(join(rootDir, "custom_integrations"));
}
