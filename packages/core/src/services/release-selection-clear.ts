/** Selection metadata only. Does not modify images, running state or evidence. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseReleaseComposeSelection } from "./release-manifest";
import {
  ensureReleaseStateDirectories,
  releaseStateFileProblem,
  releaseStatePaths,
} from "./release-state";
import { acquireReleaseStoreLock } from "./release-store-lock";
export async function clearReleaseComposeSelection(opts: {
  path: string;
  expectedReleaseId?: string;
  expectedOverlayDigest?: string | null;
  infraDir?: string;
  uid?: number;
}): Promise<{ path: string; cleared: boolean }> {
  if (opts.expectedOverlayDigest != null && !/^[a-f0-9]{64}$/.test(opts.expectedOverlayDigest))
    throw Error("Invalid release selection digest");
  const path = resolve(opts.path);
  const parent = dirname(path);
  const infraDir = opts.infraDir ?? resolve(parent, "../../..");
  const stateOptions = { uid: opts.uid };
  const paths = releaseStatePaths(infraDir);
  if (resolve(paths.overlay) !== path) throw Error("Release selection path is unsafe");
  ensureReleaseStateDirectories(infraDir, stateOptions);
  const store = paths.store;
  const lock = await acquireReleaseStoreLock(store, {}, { failIfBusy: true });
  try {
    let selected: Stats;
    try {
      selected = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (opts.expectedReleaseId !== undefined || typeof opts.expectedOverlayDigest === "string")
        throw Error("Release selection changed");
      return { path, cleared: false };
    }
    if (opts.expectedOverlayDigest === null) throw Error("Release selection changed");
    if (
      releaseStateFileProblem(selected, 128 * 1024, stateOptions) !== null ||
      !selected.isFile() ||
      selected.isSymbolicLink() ||
      selected.nlink !== 1 ||
      (opts.expectedReleaseId !== undefined && selected.size > 64 * 1024)
    )
      throw Error("Release selection overlay is unsafe");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (
        opened.dev !== selected.dev ||
        opened.ino !== selected.ino ||
        opened.size !== selected.size
      )
        throw Error("Release selection changed");
      if (opts.expectedReleaseId !== undefined || opts.expectedOverlayDigest !== undefined) {
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) throw Error("Release selection changed");
          offset += count;
        }
        if (
          (opts.expectedReleaseId !== undefined &&
            parseReleaseComposeSelection(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
              .release !== opts.expectedReleaseId) ||
          (opts.expectedOverlayDigest !== undefined &&
            createHash("sha256").update(bytes).digest("hex") !== opts.expectedOverlayDigest)
        )
          throw Error("Release selection changed");
      }
      const after = lstatSync(path);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.nlink !== 1
      )
        throw Error("Release selection changed");
      unlinkSync(path);
    } finally {
      closeSync(fd);
    }
    const descriptor = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return { path, cleared: true };
  } finally {
    lock.release();
  }
}
