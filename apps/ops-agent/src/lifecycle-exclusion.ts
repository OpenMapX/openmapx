import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { isContainedProcessFailure } from "./docker-runtime";

interface Waiter {
  ids: string[];
  signal: AbortSignal;
  grant(release: () => void): void;
  abort(): void;
}
const FAILED = "Service lifecycle settlement is unresolved; host reconciliation required";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Auxiliary serialization/denial, never a substitute for existing root/target authority.
 * One instance is shared by the actual production lifecycle and repository adapters.
 * Pending effects are durable denials across restart; no TTL or PID can clear them. */
export class ServiceLifecycleExclusion {
  private active = new Set<string>();
  private waiting: Waiter[] = [];
  private pending: Set<string>;
  private directory: string;
  private file: string;
  constructor(infraDir: string) {
    // An older agent may have retained an unresolved effect here. A new,
    // empty canonical store must never silently discard that denial.
    try {
      lstatSync(join(infraDir, ".service-lifecycle"));
      throw Error(FAILED);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = services.agentStatePaths(infraDir).directory;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.directory = join(state, "service-lifecycle");
    try {
      mkdirSync(this.directory, { mode: 0o700 });
      const parent = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const dir = lstatSync(this.directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== (process.geteuid?.() ?? 0) ||
      (dir.mode & 0o777) !== 0o700
    )
      throw Error(FAILED);
    this.file = join(this.directory, "pending.json");
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== dir.uid ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 64 * 1024
      )
        throw Error(FAILED);
      const ids: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (
        !Array.isArray(ids) ||
        ids.length > 256 ||
        ids.some((id) => typeof id !== "string" || !ID.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw Error(FAILED);
      this.pending = new Set(ids);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.pending = new Set();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private persist(next: Set<string>): void {
    if (next.size > 256) throw Error(FAILED);
    const temporary = `${this.file}.tmp`;
    try {
      const stat = lstatSync(temporary);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== (process.geteuid?.() ?? 0) ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 64 * 1024
      )
        throw Error(FAILED);
      rmSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify([...next].sort()));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    const parent = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    this.pending = next;
  }
  private drain(): void {
    const earlier = new Set<string>();
    for (const waiter of [...this.waiting]) {
      if (waiter.ids.some((id) => this.active.has(id) || earlier.has(id))) {
        for (const id of waiter.ids) earlier.add(id);
        continue;
      }
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      for (const id of waiter.ids) this.active.add(id);
      waiter.grant(() => {
        for (const id of waiter.ids) this.active.delete(id);
        this.drain();
      });
    }
  }
  private async acquire(ids: string[], signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((grant, reject) => {
      const waiter: Waiter = {
        ids,
        signal,
        grant,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(signal.reason);
          this.drain();
        },
      };
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
      else this.drain();
    });
  }
  async run<T>(
    serviceIds: readonly string[],
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    if (serviceIds.length > 256 || serviceIds.some((id) => !ID.test(id))) throw Error(FAILED);
    const ids = [...new Set(serviceIds)].sort();
    const release = await this.acquire(ids, signal);
    try {
      signal.throwIfAborted();
      if (ids.some((id) => this.pending.has(id))) throw Error(FAILED);
      return await work();
    } finally {
      release();
    }
  }
  async creating<T>(
    serviceIds: readonly string[],
    signal: AbortSignal,
    work: (begin: () => void) => Promise<T>,
  ): Promise<T> {
    return this.run(serviceIds, signal, async () => {
      let begun = false;
      const begin = () => {
        signal.throwIfAborted();
        if (!begun) {
          this.persist(new Set([...this.pending, ...serviceIds]));
          begun = true;
        }
      };
      const clear = () =>
        this.persist(new Set([...this.pending].filter((id) => !serviceIds.includes(id))));
      try {
        const result = await work(begin);
        if (begun) clear();
        return result;
      } catch (error) {
        if (begun && isContainedProcessFailure(error)) clear();
        throw error;
      }
    });
  }
}
