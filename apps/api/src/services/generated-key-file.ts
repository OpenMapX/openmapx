import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** The length of a generated key: 32 bytes as unpadded base64url. */
const ENCODED_BYTES = 43;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Read a key that `openmapx compose render` generated: exactly 32 random bytes
 * as 43 canonical base64url characters, with no newline, in a regular file
 * with one link, mode 0444 and the expected owner. The rule is the render's
 * own, so a file the API accepts is one a render keeps. The file is read
 * through one descriptor, and no error includes its bytes.
 *
 * `configuredUid` is the owner the deployment declares; without one the file
 * must belong to the user this process runs as.
 */
export function readGeneratedKeyFile(
  path: string,
  label: string,
  configuredUid: string | undefined,
): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new Error(`${label} must be a regular file`);
    throw new Error(`${label} is missing or unreadable`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.nlink !== 1) throw new Error(`${label} must have one link`);
    if ((stat.mode & 0o777) !== 0o444) throw new Error(`${label} must have mode 0444`);
    const declared = configuredUid?.trim();
    const expectedUid = declared
      ? Number(declared)
      : typeof process.getuid === "function"
        ? process.getuid()
        : stat.uid;
    if (!Number.isSafeInteger(expectedUid) || expectedUid < 0 || stat.uid !== expectedUid) {
      throw new Error(`${label} has an invalid owner`);
    }
    if (stat.size !== ENCODED_BYTES) throw new Error(`${label} has an invalid size`);
    const bytes = Buffer.alloc(ENCODED_BYTES + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead !== ENCODED_BYTES) throw new Error(`${label} has an invalid size`);
    const encoded = bytes.subarray(0, bytesRead).toString("ascii");
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error(`${label} is not canonical base64url`);
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
      throw new Error(`${label} is not canonical 32-byte base64url`);
    }
    return decoded;
  } finally {
    closeSync(fd);
  }
}
