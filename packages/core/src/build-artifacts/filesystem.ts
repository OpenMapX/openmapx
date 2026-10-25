/** Server-local descriptor anchoring. Never accepts archive paths without component validation. */
import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  constants as C,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
export type FileIdentity = { dev: string; ino: string };
export const identity = (s: BigIntStats): FileIdentity => ({
  dev: String(s.dev),
  ino: String(s.ino),
});
export const sameInode = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
function component(name: string) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    Buffer.byteLength(name) > 255
  )
    throw Error("Unsafe filesystem component");
}
export class AnchoredDirectory {
  readonly fd: number;
  readonly stat: BigIntStats;
  readonly anchor: string;
  private closed = false;
  constructor(
    readonly path: string,
    readonly parent?: AnchoredDirectory,
    private strict = false,
    private allowSystemOwner = false,
  ) {
    if (!isAbsolute(path)) throw Error("Absolute trusted root required");
    this.fd = openSync(path, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try {
      this.stat = fstatSync(this.fd, { bigint: true });
      this.anchor =
        process.platform === "linux"
          ? `/proc/self/fd/${this.fd}`
          : process.platform === "darwin"
            ? `/.vol/${this.stat.dev}/${this.stat.ino}`
            : "";
      if (
        !this.anchor ||
        !sameInode(identity(this.stat), identity(statSync(this.anchor, { bigint: true })))
      )
        throw Error("Descriptor filesystem anchoring unavailable");
      this.check();
    } catch (e) {
      closeSync(this.fd);
      throw e;
    }
  }
  check() {
    if (this.closed) throw Error("Closed directory authority");
    this.parent?.check();
    const current = fstatSync(this.fd, { bigint: true });
    const path = lstatSync(this.path, { bigint: true });
    if (
      !current.isDirectory() ||
      !path.isDirectory() ||
      (current.uid !== BigInt(process.getuid?.() ?? -1) &&
        !(this.allowSystemOwner && current.uid === 0n)) ||
      (current.mode & BigInt(this.strict ? 0o077 : 0o022)) !== 0n ||
      !sameInode(identity(this.stat), identity(current)) ||
      !sameInode(identity(current), identity(path))
    )
      throw Error("Directory authority changed or unsafe");
  }
  name(name: string) {
    component(name);
    this.check();
    return join(this.anchor, name);
  }
  directory(name: string, create = false, strict = this.strict): AnchoredDirectory {
    const path = this.name(name);
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
        fsyncSync(this.fd);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    return new AnchoredDirectory(path, this, strict);
  }
  list() {
    this.check();
    return readdirSync(this.anchor);
  }
  listBounded(maximum: number): string[] {
    this.check();
    const dir = opendirSync(this.anchor);
    const names: string[] = [];
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (names.length >= maximum) throw Error("Authority directory capacity exceeded");
        names.push(entry.name);
      }
      return names;
    } finally {
      dir.closeSync();
    }
  }
  hasEntries(): boolean {
    this.check();
    const dir = opendirSync(this.anchor);
    try {
      return dir.readSync() !== null;
    } finally {
      dir.closeSync();
    }
  }
  read(name: string, maximum: number, privateMode = true): Buffer {
    const path = this.name(name);
    const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.getuid?.() ?? -1) ||
        (before.mode & BigInt(privateMode ? 0o077 : 0o022)) !== 0n ||
        before.size > BigInt(maximum)
      )
        throw Error("Unsafe or oversized regular file");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < buffer.length) {
        const n = readSync(fd, buffer, count, buffer.length - count, null);
        if (!n) break;
        count += n;
      }
      const bytes = buffer.subarray(0, count);
      const after = fstatSync(fd, { bigint: true });
      if (
        BigInt(bytes.length) !== before.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        !sameInode(identity(before), identity(lstatSync(path, { bigint: true })))
      )
        throw Error("Regular file changed during read");
      this.check();
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  fileIdentity(name: string): FileIdentity {
    const path = this.name(name);
    const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const value = fstatSync(fd, { bigint: true });
      if (
        !value.isFile() ||
        value.nlink !== 1n ||
        value.uid !== BigInt(process.getuid?.() ?? -1) ||
        (value.mode & 0o077n) !== 0n ||
        !sameInode(identity(value), identity(lstatSync(path, { bigint: true })))
      )
        throw Error("Unsafe retained record inode");
      return identity(value);
    } finally {
      closeSync(fd);
    }
  }
  write(
    name: string,
    bytes: string | Buffer,
    exclusive = false,
    beforePublish?: (inode: FileIdentity) => void,
  ) {
    const target = this.name(name);
    const temporary = exclusive ? name : `.write-${randomUUID()}`;
    const path = this.name(temporary);
    const fd = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    const expected = identity(fstatSync(fd, { bigint: true }));
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        beforePublish?.(expected);
        this.check();
      } finally {
        closeSync(fd);
      }
      if (!exclusive) renameSync(path, target);
      fsyncSync(this.fd);
    } catch (error) {
      // Only remove this call's unpublished temporary inode. Published or
      // exclusive evidence, and unexplained replacements, remain fenced.
      if (!exclusive) {
        try {
          const current = lstatSync(path, { bigint: true });
          if (!current.isFile() || current.nlink !== 1n || !sameInode(identity(current), expected))
            throw Error("Refusing replaced authority temporary");
          unlinkSync(path);
          fsyncSync(this.fd);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
            throw new AggregateError([error, cleanup], "Authority write requires recovery");
        }
      }
      throw error;
    }
  }
  removeFile(name: string) {
    unlinkSync(this.name(name));
    fsyncSync(this.fd);
  }
  removeDirectory(name: string, expected: FileIdentity) {
    const child = this.directory(name);
    try {
      if (!sameInode(identity(child.stat), expected) || child.listBounded(1).length)
        throw Error("Refusing replaced or nonempty lock");
      rmdirSync(this.name(name));
      fsyncSync(this.fd);
    } finally {
      child.close();
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
export function withDirectories<T>(
  root: AnchoredDirectory,
  components: readonly string[],
  create: boolean,
  run: (parent: AnchoredDirectory) => T,
): T {
  const dirs: AnchoredDirectory[] = [];
  let current = root;
  try {
    for (const name of components) {
      current = current.directory(name, create);
      dirs.push(current);
    }
    return run(current);
  } finally {
    for (const dir of dirs.reverse()) dir.close();
  }
}
