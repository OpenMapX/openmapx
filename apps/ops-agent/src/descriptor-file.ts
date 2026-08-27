import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const MAX_PATH_COMPONENTS = 16;
const MAX_COMPONENT_BYTES = 255;
const MAX_SUPPORTED_READ_BYTES = 16 * 1024 * 1024;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export interface DescriptorReadHooks {
  descriptorOpened?(descriptor: number): void;
  afterRootOpen?(): void;
  afterDirectoryOpen?(input: { index: number; name: string }): void;
  afterFileOpen?(): void;
  afterRead?(): void;
  afterDirectoryRead?(): void;
}

export interface DescriptorDirectoryEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
}

export interface DescriptorReadOptions {
  maximumBytes: number;
  minimumBytes?: number;
  descriptorAnchorRoot?: string;
  hooks?: DescriptorReadHooks;
}

interface OpenedEntry {
  descriptor: number;
  identity: BigIntStats;
  pathname: string;
  kind: "directory" | "file";
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeDirectory(stat: BigIntStats, expectedUid: bigint): boolean {
  return (
    stat.isDirectory() &&
    stat.uid === expectedUid &&
    stat.nlink >= 1n &&
    (stat.mode & 0o022n) === 0n
  );
}

function safeFile(
  stat: BigIntStats,
  expectedUid: bigint,
  minimumBytes: number,
  maximumBytes: number,
): boolean {
  return (
    stat.isFile() &&
    stat.uid === expectedUid &&
    stat.nlink === 1n &&
    (stat.mode & 0o022n) === 0n &&
    stat.size >= BigInt(minimumBytes) &&
    stat.size <= BigInt(maximumBytes)
  );
}

function anchoredPath(anchorRoot: string, descriptor: number, name: string): string {
  return join(anchorRoot, String(descriptor), name);
}

function readExact(descriptor: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, offset, size - offset, offset);
    if (count < 1) throw new Error("short read");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (readSync(descriptor, extra, 0, 1, size) !== 0) throw new Error("file grew");
  return buffer;
}

/**
 * Read a fixed relative file without ever reopening a caller-controlled path.
 * Linux production must expose `/proc/self/fd`; other platforms use their
 * equivalent `/dev/fd` only for development and tests.
 */
export function readDescriptorAnchoredUtf8(
  rootDir: string,
  components: readonly string[],
  options: DescriptorReadOptions,
): string {
  const opened: OpenedEntry[] = [];
  const descriptors: number[] = [];
  try {
    const minimumBytes = options.minimumBytes ?? 0;
    if (
      !isAbsolute(rootDir) ||
      components.length < 1 ||
      components.length > MAX_PATH_COMPONENTS ||
      components.some(
        (component) =>
          !SAFE_COMPONENT.test(component) ||
          Buffer.byteLength(component, "utf8") > MAX_COMPONENT_BYTES,
      ) ||
      !Number.isInteger(minimumBytes) ||
      minimumBytes < 0 ||
      !Number.isInteger(options.maximumBytes) ||
      options.maximumBytes < minimumBytes ||
      options.maximumBytes > MAX_SUPPORTED_READ_BYTES
    ) {
      throw new Error("invalid descriptor read request");
    }
    const descriptorAnchorRoot = options.descriptorAnchorRoot ?? "/proc/self/fd";
    if (!statSync(descriptorAnchorRoot).isDirectory())
      throw new Error("descriptor anchor unavailable");

    const rootDescriptor = openSync(
      rootDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    descriptors.push(rootDescriptor);
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    if (!safeDirectory(rootIdentity, rootIdentity.uid)) throw new Error("unsafe root");
    opened.push({
      descriptor: rootDescriptor,
      identity: rootIdentity,
      pathname: rootDir,
      kind: "directory",
    });
    options.hooks?.descriptorOpened?.(rootDescriptor);
    options.hooks?.afterRootOpen?.();

    const expectedUid = rootIdentity.uid;
    let parentDescriptor = rootDescriptor;
    for (let index = 0; index < components.length - 1; index += 1) {
      const name = components[index] as string;
      const pathname = anchoredPath(descriptorAnchorRoot, parentDescriptor, name);
      const descriptor = openSync(
        pathname,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      const identity = fstatSync(descriptor, { bigint: true });
      if (!safeDirectory(identity, expectedUid)) throw new Error("unsafe directory");
      opened.push({ descriptor, identity, pathname, kind: "directory" });
      options.hooks?.descriptorOpened?.(descriptor);
      options.hooks?.afterDirectoryOpen?.({ index, name });
      parentDescriptor = descriptor;
    }

    const filename = components.at(-1) as string;
    const pathname = anchoredPath(descriptorAnchorRoot, parentDescriptor, filename);
    const descriptor = openSync(
      pathname,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(descriptor);
    const identity = fstatSync(descriptor, { bigint: true });
    if (!safeFile(identity, expectedUid, minimumBytes, options.maximumBytes)) {
      throw new Error("unsafe file");
    }
    opened.push({ descriptor, identity, pathname, kind: "file" });
    options.hooks?.descriptorOpened?.(descriptor);
    options.hooks?.afterFileOpen?.();

    const size = Number(identity.size);
    const first = readExact(descriptor, size);
    options.hooks?.afterRead?.();
    const second = readExact(descriptor, size);
    if (!first.equals(second)) throw new Error("unstable file contents");

    for (const entry of opened) {
      const descriptorIdentity = fstatSync(entry.descriptor, { bigint: true });
      const pathIdentity = lstatSync(entry.pathname, { bigint: true });
      if (
        !sameIdentity(entry.identity, descriptorIdentity) ||
        !sameIdentity(entry.identity, pathIdentity) ||
        (entry.kind === "directory"
          ? !safeDirectory(descriptorIdentity, expectedUid)
          : !safeFile(descriptorIdentity, expectedUid, minimumBytes, options.maximumBytes))
      ) {
        throw new Error("unstable file identity");
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(first);
  } catch {
    throw new Error("Trusted file read rejected");
  } finally {
    for (const descriptor of descriptors.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the redacted read failure while still attempting every close.
      }
    }
  }
}

export function listDescriptorAnchoredDirectory(
  rootDir: string,
  components: readonly string[],
  options: {
    maximumEntries: number;
    descriptorAnchorRoot?: string;
    hooks?: DescriptorReadHooks;
  },
): DescriptorDirectoryEntry[] {
  const descriptors: number[] = [];
  const opened: OpenedEntry[] = [];
  try {
    if (
      !isAbsolute(rootDir) ||
      components.length > MAX_PATH_COMPONENTS ||
      components.some((component) => !SAFE_COMPONENT.test(component)) ||
      !Number.isInteger(options.maximumEntries) ||
      options.maximumEntries < 1 ||
      options.maximumEntries > 8_192
    ) {
      throw new Error("invalid descriptor directory request");
    }
    const anchor = options.descriptorAnchorRoot ?? "/proc/self/fd";
    if (!statSync(anchor).isDirectory()) throw new Error("descriptor anchor unavailable");
    const rootDescriptor = openSync(
      rootDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    descriptors.push(rootDescriptor);
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    if (!safeDirectory(rootIdentity, rootIdentity.uid)) throw new Error("unsafe root");
    opened.push({
      descriptor: rootDescriptor,
      identity: rootIdentity,
      pathname: rootDir,
      kind: "directory",
    });
    options.hooks?.descriptorOpened?.(rootDescriptor);
    options.hooks?.afterRootOpen?.();
    let descriptor = rootDescriptor;
    for (let index = 0; index < components.length; index += 1) {
      const name = components[index] as string;
      const pathname = anchoredPath(anchor, descriptor, name);
      descriptor = openSync(
        pathname,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      const identity = fstatSync(descriptor, { bigint: true });
      if (!safeDirectory(identity, rootIdentity.uid)) throw new Error("unsafe directory");
      opened.push({ descriptor, identity, pathname, kind: "directory" });
      options.hooks?.descriptorOpened?.(descriptor);
      options.hooks?.afterDirectoryOpen?.({ index, name });
    }

    const directory = opendirSync(join(anchor, String(descriptor)));
    const entries: DescriptorDirectoryEntry[] = [];
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entries.length >= options.maximumEntries)
          throw new Error("directory entry limit exceeded");
        if (
          !SAFE_COMPONENT.test(entry.name) ||
          Buffer.byteLength(entry.name, "utf8") > MAX_COMPONENT_BYTES
        ) {
          throw new Error("unsafe directory entry");
        }
        entries.push({
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        });
      }
    } finally {
      directory.closeSync();
    }
    options.hooks?.afterDirectoryRead?.();
    for (const item of opened) {
      const descriptorIdentity = fstatSync(item.descriptor, { bigint: true });
      const pathIdentity = lstatSync(item.pathname, { bigint: true });
      if (
        !sameIdentity(item.identity, descriptorIdentity) ||
        !sameIdentity(item.identity, pathIdentity) ||
        !safeDirectory(descriptorIdentity, rootIdentity.uid)
      ) {
        throw new Error("unstable directory identity");
      }
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    throw new Error("Trusted directory listing rejected");
  } finally {
    for (const descriptor of descriptors.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue closing every descriptor.
      }
    }
  }
}

export interface DescriptorEntryMetadata {
  type: "directory" | "file";
  sizeBytes: number;
  modifiedAtMs: number;
}

/**
 * Metadata for one fixed relative entry, read from the descriptor the walk
 * opened rather than from a second pathname lookup. Enumerating a directory and
 * then re-opening the chosen name by path lets a rename in between fabricate
 * the reported size, timestamp, or existence; this returns the already-opened
 * entry's validated stat instead.
 */
export function statDescriptorAnchoredEntry(
  rootDir: string,
  components: readonly string[],
  options: { descriptorAnchorRoot?: string } = {},
): DescriptorEntryMetadata {
  const descriptors: number[] = [];
  const opened: OpenedEntry[] = [];
  try {
    if (
      !isAbsolute(rootDir) ||
      components.length < 1 ||
      components.length > MAX_PATH_COMPONENTS ||
      components.some(
        (component) =>
          !SAFE_COMPONENT.test(component) ||
          Buffer.byteLength(component, "utf8") > MAX_COMPONENT_BYTES,
      )
    ) {
      throw new Error("invalid descriptor stat request");
    }
    const anchor = options.descriptorAnchorRoot ?? "/proc/self/fd";
    if (!statSync(anchor).isDirectory()) throw new Error("descriptor anchor unavailable");

    const rootDescriptor = openSync(
      rootDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    descriptors.push(rootDescriptor);
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    if (!safeDirectory(rootIdentity, rootIdentity.uid)) throw new Error("unsafe root");
    opened.push({
      descriptor: rootDescriptor,
      identity: rootIdentity,
      pathname: rootDir,
      kind: "directory",
    });

    let parentDescriptor = rootDescriptor;
    for (let index = 0; index < components.length - 1; index += 1) {
      const pathname = anchoredPath(anchor, parentDescriptor, components[index] as string);
      const descriptor = openSync(
        pathname,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      const identity = fstatSync(descriptor, { bigint: true });
      if (!safeDirectory(identity, rootIdentity.uid)) throw new Error("unsafe directory");
      opened.push({ descriptor, identity, pathname, kind: "directory" });
      parentDescriptor = descriptor;
    }

    const pathname = anchoredPath(anchor, parentDescriptor, components.at(-1) as string);
    const descriptor = openSync(
      pathname,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(descriptor);
    const identity = fstatSync(descriptor, { bigint: true });
    const isDirectory = identity.isDirectory();
    if (!isDirectory && !identity.isFile()) throw new Error("unsupported entry type");
    if (
      isDirectory
        ? !safeDirectory(identity, rootIdentity.uid)
        : !safeFile(identity, rootIdentity.uid, 0, MAX_SUPPORTED_READ_BYTES)
    ) {
      throw new Error("unsafe entry");
    }
    opened.push({
      descriptor,
      identity,
      pathname,
      kind: isDirectory ? "directory" : "file",
    });

    for (const item of opened) {
      const descriptorIdentity = fstatSync(item.descriptor, { bigint: true });
      const pathIdentity = lstatSync(item.pathname, { bigint: true });
      if (
        !sameIdentity(item.identity, descriptorIdentity) ||
        !sameIdentity(item.identity, pathIdentity)
      ) {
        throw new Error("unstable entry identity");
      }
    }
    return {
      type: isDirectory ? "directory" : "file",
      sizeBytes: Number(identity.size),
      modifiedAtMs: Number(identity.mtimeMs),
    };
  } catch {
    throw new Error("Trusted entry metadata rejected");
  } finally {
    for (const descriptor of descriptors.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue closing every descriptor.
      }
    }
  }
}
