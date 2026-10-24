import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const NAME = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;

/**
 * A directory the agent writes into although another container can change
 * its path, such as data-manager's data mount. It is reached from a trusted
 * root one component at a time, never following a symbolic link, and on Linux
 * every later access goes through the opened descriptor (`/proc/self/fd`), so
 * swapping a component for a symlink after the walk changes nothing.
 * Elsewhere (development and tests) the components are checked the same way
 * but accessed by path.
 */
export interface AnchoredDirectory {
  /** Replace `name` with `contents` via an exclusively created random temporary. */
  replaceFile(name: string, contents: string, mode: number): void;
  /** Create `name`, failing if anything, a symlink included, is already there. */
  createFile(name: string, contents: string, mode: number): void;
  /** Remove `name` if present; a symlink there is removed, not followed. */
  removeFile(name: string): void;
  close(): void;
}

export interface AnchoredDirectoryOptions {
  /** Create missing components (mode 0755) instead of failing. */
  create?: boolean;
  /** `/proc/self/fd` on Linux; `null` checks components by path instead. */
  descriptorAnchorRoot?: string | null;
}

function defaultAnchorRoot(): string | null {
  return existsSync("/proc/self/fd") ? "/proc/self/fd" : null;
}

function assertName(name: string): void {
  if (!NAME.test(name) || name === "." || name === "..") throw new Error("Unsafe file name");
}

export function openAnchoredDirectory(
  root: string,
  components: readonly string[],
  options: AnchoredDirectoryOptions = {},
): AnchoredDirectory {
  if (!isAbsolute(root) || components.some((component) => !COMPONENT.test(component))) {
    throw new Error("Unsafe anchored directory");
  }
  const anchorRoot =
    options.descriptorAnchorRoot === undefined ? defaultAnchorRoot() : options.descriptorAnchorRoot;
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const descriptors: number[] = [];
  let path = root;
  try {
    descriptors.push(openSync(root, directoryFlags));
    for (const component of components) {
      const parent = descriptors.at(-1) as number;
      const child = anchorRoot
        ? join(anchorRoot, String(parent), component)
        : join(path, component);
      if (options.create) {
        try {
          mkdirSync(child, { mode: 0o755 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!anchorRoot) {
        const metadata = lstatSync(child);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error("Unsafe anchored directory");
        }
      }
      descriptors.push(openSync(child, directoryFlags));
      path = join(path, component);
    }
    const directory = descriptors.at(-1) as number;
    if (!fstatSync(directory).isDirectory()) throw new Error("Unsafe anchored directory");
    const entry = (name: string) => {
      assertName(name);
      return anchorRoot ? join(anchorRoot, String(directory), name) : join(path, name);
    };
    const writeExclusive = (target: string, contents: string, mode: number) => {
      const descriptor = openSync(
        target,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        mode,
      );
      try {
        writeFileSync(descriptor, contents, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    };
    return {
      replaceFile(name, contents, mode) {
        const temporary = entry(
          `.${name.replace(/^\./, "")}.${randomBytes(12).toString("hex")}.tmp`,
        );
        const target = entry(name);
        try {
          writeExclusive(temporary, contents, mode);
          renameSync(temporary, target);
        } catch (error) {
          try {
            unlinkSync(temporary);
          } catch {
            // Never created, or already renamed into place.
          }
          throw error;
        }
        fsyncSync(directory);
      },
      createFile(name, contents, mode) {
        writeExclusive(entry(name), contents, mode);
        fsyncSync(directory);
      },
      removeFile(name) {
        try {
          unlinkSync(entry(name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
      close() {
        for (const descriptor of descriptors.splice(0).reverse()) closeSync(descriptor);
      },
    };
  } catch (error) {
    for (const descriptor of descriptors.splice(0).reverse()) closeSync(descriptor);
    throw error;
  }
}
