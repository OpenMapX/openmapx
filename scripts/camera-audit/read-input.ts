import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Bound both allocation and actual bytes, using one stable regular-file descriptor. */
export function readAuditInput(path: string): Buffer {
  const limit = 5 * 1024 * 1024;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Input must be a regular file");
    if (stat.size > limit) throw new Error("Input size exceeds 5 MiB");
    // One extra byte detects a file growing after fstat without an unbounded read.
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > limit) throw new Error("Input size exceeds 5 MiB");
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
