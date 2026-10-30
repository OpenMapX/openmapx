/** Selection metadata only. Does not modify images, running state or evidence. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseReleaseComposeSelection } from "./release-manifest";
import { acquireReleaseStoreLock } from "./release-store-lock";
export async function clearReleaseComposeSelection(opts: {
  path: string;
  expectedReleaseId?: string;
}): Promise<{ path: string; cleared: boolean }> {
  const path = opts.path,
    parent = dirname(path);
  const assertDirectory = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Release selection directory is unsafe");
  };
  assertDirectory(parent);
  const store = join(parent, ".ops-agent-releases");
  try {
    mkdirSync(store, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertDirectory(store);
  const lock = await acquireReleaseStoreLock(store, {}, { failIfBusy: true });
  try {
    try {
      lstatSync(join(store, "transaction.json"));
      throw Error(
        "Release transaction is active; finish or recover the update before clearing selection",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let selected: Stats;
    try {
      selected = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (opts.expectedReleaseId !== undefined) throw Error("Release selection changed");
      return { path, cleared: false };
    }
    if (
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
      if (opts.expectedReleaseId !== undefined) {
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) throw Error("Release selection changed");
          offset += count;
        }
        const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (parseReleaseComposeSelection(contents).release !== opts.expectedReleaseId)
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
