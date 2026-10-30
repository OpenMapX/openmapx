import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Reads a regular, singly linked file. Every check is made on the opened
 * descriptor, so the file cannot be swapped between check and read. A missing
 * file keeps its ENOENT code; a symbolic link fails to open. With an `owner`,
 * the file must also belong to that uid and be unwritable by its group and
 * others, as the agent's own state is.
 */
export function strictReadFile(
  path: string,
  maximum: number,
  options: { owner?: number } = {},
): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("Release authority rejected");
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maximum ||
      (options.owner !== undefined && (opened.uid !== options.owner || (opened.mode & 0o022) !== 0))
    ) {
      throw new Error("Release authority rejected");
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error("Release authority rejected");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("Release authority rejected");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}
