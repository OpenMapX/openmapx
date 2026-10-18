import assert from "node:assert/strict";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Validate a precreated fixture without creating, repairing, or removing it. */
export async function withPrivateFixture<T>(
  root: string,
  sharedChild: string,
  operation: (resolvedSharedChild: string) => Promise<T>,
  effectiveUid: number | undefined,
): Promise<T> {
  // Strip trailing separators before lstat so they cannot cause it to follow a root symlink.
  const rootPath = resolve(root);
  const metadata = lstatSync(rootPath);
  assert(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    "fixture root must be an actual directory, not a symlink",
  );
  assert(
    effectiveUid !== undefined && Number.isInteger(effectiveUid) && effectiveUid >= 0,
    "cannot establish effective UID for fixture ownership",
  );
  assert.equal(metadata.uid, effectiveUid, "fixture root must be owned by the effective UID");
  assert.equal(metadata.mode & 0o7777, 0o700, "fixture root must already have private mode 0700");

  // Resolve system aliases such as macOS /tmp, but reject a link at the root itself above.
  const resolvedRoot = realpathSync(rootPath);
  const resolvedSharedChild = realpathSync(sharedChild);
  const childPath = relative(resolvedRoot, resolvedSharedChild);
  assert(
    childPath !== "" &&
      childPath !== ".." &&
      !childPath.startsWith(`..${sep}`) &&
      !isAbsolute(childPath),
    "fixture shared child must resolve inside the private root",
  );
  assert(statSync(resolvedSharedChild).isDirectory(), "fixture shared child must be a directory");
  return operation(resolvedSharedChild);
}
