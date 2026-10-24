import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Reads files from installed integration directories.
 *
 * With an operations agent, the agent owns `custom_integrations` and records
 * the SHA-256 of every file it installed there. The API reads a file from such
 * a directory only when it is one of those files and its bytes still match;
 * anything else is ignored with a warning. Directories outside the agent's
 * (built-in integrations, or every directory in host development) are read as
 * they are.
 */

/** Base directories whose integrations are verified. */
let verifiedRoots: string[] = [];
/** Resolved integration directory -> POSIX path relative to it -> SHA-256. */
let digestsByDirectory = new Map<string, ReadonlyMap<string, string>>();
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[integration-host] ${message}`);
}

/**
 * Replace the verified file set: `roots` are the base directories the agent
 * owns, `directories` the integration directories under them it reported
 * intact, with their file digests. Directories under a root that are not
 * listed are not read at all.
 */
export function setVerifiedIntegrationFiles(
  roots: readonly string[],
  directories: ReadonlyMap<string, ReadonlyArray<{ path: string; sha256: string }>>,
): void {
  verifiedRoots = roots.map((root) => resolve(root));
  digestsByDirectory = new Map(
    [...directories].map(([directory, files]) => [
      resolve(directory),
      new Map(files.map((file) => [file.path, file.sha256])),
    ]),
  );
  warned.clear();
}

function underVerifiedRoot(directory: string): boolean {
  return verifiedRoots.some((root) => {
    const path = relative(root, directory);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  });
}

/**
 * The bytes of `relativePath` in an integration directory, or null when it is
 * missing or, in a verified directory, is not exactly what the agent
 * installed.
 */
export function readIntegrationFile(directory: string, relativePath: string): Buffer | null {
  const root = resolve(directory);
  const path = join(root, relativePath);
  const digests = digestsByDirectory.get(root);
  if (!digests) {
    if (underVerifiedRoot(root)) {
      warnOnce(
        `${root}\0`,
        `${root} was not installed by the operations agent; its files are not read`,
      );
      return null;
    }
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }
  const posixPath = relative(root, path).split(sep).join("/");
  const expected = digests.get(posixPath);
  if (!expected) {
    if (existsSync(path)) {
      warnOnce(
        `${root}\0${posixPath}`,
        `Ignoring ${posixPath} in ${root}: the operations agent did not install it`,
      );
    }
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    warnOnce(
      `${root}\0${posixPath}\0${expected}`,
      `Ignoring ${posixPath} in ${root}: it changed since the operations agent installed it`,
    );
    return null;
  }
  return bytes;
}
