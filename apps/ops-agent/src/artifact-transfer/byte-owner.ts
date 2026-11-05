/** Linux byte-stream exclusion. flock operates on the inherited descriptor;
 * the original Node descriptor retains its kernel lock after flock exits.
 * Only descriptor closure/process death releases it. TTL and PID age grant nothing. */
import { spawn } from "node:child_process";
import { constants as C, closeSync, fstatSync, lstatSync, openSync } from "node:fs";
import { ArtifactTransferError } from "./errors";

export async function acquireArtifactByteOwner(
  path: string,
): Promise<null | { release(): Promise<void> }> {
  // Supported deployments are Linux. Other development platforms keep orphan
  // bytes fenced rather than claiming kernel containment they cannot establish.
  if (process.platform !== "linux") return null;
  const fd = openSync(path, C.O_CREAT | C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n)
      throw new ArtifactTransferError(409, "Artifact byte owner is unavailable");
    // No shell and no request-selected executable/arguments. fd3 is a duplicate
    // of this exact open file description; flock never opens a pathname.
    const child = spawn("/usr/bin/flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: { PATH: process.env.PATH },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", () =>
        reject(new ArtifactTransferError(503, "Artifact byte locking is unavailable")),
      );
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new ArtifactTransferError(409, "Artifact byte stream is still owned")),
      );
    });
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1n)
      throw new ArtifactTransferError(409, "Artifact byte owner changed");
    let released = false;
    return {
      async release() {
        if (!released) {
          released = true;
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
