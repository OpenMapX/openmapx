import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

const FAILED = "Trusted authority filesystem rejected";

export type TrustedAuthorityKind = "service" | "integration";

export interface TrustedAuthorityReadHooks {
  beforeManifestOpen?(kind: TrustedAuthorityKind, path: string): void;
}

interface DirectoryHandle {
  fd: number;
  dev: number;
  ino: number;
}

export class TrustedAuthorityFilesystem {
  readonly root: string;
  private readonly directories = new Map<string, DirectoryHandle>();
  private closed = false;

  constructor(
    root: string,
    private readonly uid: number,
    private readonly hooks: TrustedAuthorityReadHooks = {},
  ) {
    this.root = resolve(root);
    this.openDirectory(this.root);
  }

  private contained(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${sep}`)) {
      throw new Error(FAILED);
    }
    return resolved;
  }

  private validateDirectory(path: string, handle: DirectoryHandle): void {
    const opened = fstatSync(handle.fd);
    const current = lstatSync(path);
    if (
      !opened.isDirectory() ||
      opened.uid !== this.uid ||
      (opened.mode & 0o022) !== 0 ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== this.uid ||
      (current.mode & 0o022) !== 0 ||
      opened.dev !== handle.dev ||
      opened.ino !== handle.ino ||
      current.dev !== handle.dev ||
      current.ino !== handle.ino
    ) {
      throw new Error(FAILED);
    }
  }

  openDirectory(path: string): void {
    if (this.closed) throw new Error(FAILED);
    const resolved = this.contained(path);
    const existing = this.directories.get(resolved);
    if (existing) {
      this.validateDirectory(resolved, existing);
      return;
    }
    if (resolved !== this.root) {
      const parent = dirname(resolved);
      const parentHandle = this.directories.get(parent);
      if (!parentHandle) throw new Error(FAILED);
      this.validateDirectory(parent, parentHandle);
    }
    const fd = openSync(
      resolved,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stats = fstatSync(fd);
      const handle = { fd, dev: stats.dev, ino: stats.ino };
      this.validateDirectory(resolved, handle);
      this.directories.set(resolved, handle);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  listDirectory(path: string): Dirent[] {
    const resolved = this.contained(path);
    this.openDirectory(resolved);
    this.recheck();
    const entries = readdirSync(resolved, { withFileTypes: true });
    this.recheck();
    return entries;
  }

  readManifest(path: string, kind: TrustedAuthorityKind, maxBytes: number): Buffer {
    const resolved = this.contained(path);
    const parent = dirname(resolved);
    this.openDirectory(parent);
    this.recheck();
    this.hooks.beforeManifestOpen?.(kind, resolved);
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.uid !== this.uid ||
        (opened.mode & 0o022) !== 0 ||
        opened.size < 2 ||
        opened.size > maxBytes
      ) {
        throw new Error(FAILED);
      }
      const bytes = readFileSync(fd);
      const current = lstatSync(resolved);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.uid !== this.uid ||
        (current.mode & 0o022) !== 0 ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new Error(FAILED);
      }
      this.recheck();
      return bytes;
    } finally {
      closeSync(fd);
    }
  }

  recheck(): void {
    if (this.closed) throw new Error(FAILED);
    for (const [path, handle] of this.directories) this.validateDirectory(path, handle);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.directories.values()) closeSync(handle.fd);
    this.directories.clear();
  }
}
