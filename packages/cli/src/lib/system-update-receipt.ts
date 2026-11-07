/** Private, durable client progress. This receipt grants no server authority. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { adminPlatformConfigurationSchema } from "@openmapx/core/api-contracts";
import { atomicWrite, fsyncDirectory } from "@openmapx/core/release-files";
import { services } from "@openmapx/core/server";
import z from "zod/v4";
import { readPrivateOperatorFile } from "./admin-session";

const stepSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
  body: z.record(z.string(), z.json()).nullable(),
  response: z.json().optional(),
  finalStatus: z.number().int().min(400).max(499).optional(),
});
const identitySchema = z.strictObject({
  origin: z.url(),
  actorId: z.string().min(1),
  release: z.strictObject({
    releaseId: z.string().regex(services.RELEASE_ID_PATTERN),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  configuredSelector: z.string().min(1),
  configurationIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  createBackup: z.boolean().default(true),
});
const schema = identitySchema.extend({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  backupName: z.string().regex(/^pre-update-[a-f0-9-]{36}$/),
  baseline: adminPlatformConfigurationSchema.optional(),
  steps: z.strictObject({ backup: stepSchema, preview: stepSchema, apply: stepSchema }),
});
export type SystemUpdateReceipt = z.infer<typeof schema>;
export type UpdateStep = keyof SystemUpdateReceipt["steps"];
export class SystemUpdateReceiptStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  private parent() {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw Error("Receipt parent must be a private owned directory");
    return dir;
  }
  read(): SystemUpdateReceipt {
    try {
      this.parent();
      return schema.parse(JSON.parse(readPrivateOperatorFile(this.path, 128 * 1024)));
    } catch {
      throw Error("Update receipt unavailable or unsafe; preserve it for inspection");
    }
  }
  private async locked<T>(run: () => T): Promise<T> {
    const dir = this.parent();
    const lock = await services.acquireStoreLock(
      dir,
      `.${basename(this.path)}.lock`,
      {},
      Date.now,
      true,
    );
    try {
      return run();
    } finally {
      lock.release();
    }
  }
  async create(identity: z.input<typeof identitySchema>): Promise<SystemUpdateReceipt> {
    return this.locked(() => {
      const step = () => ({ key: `update:${randomUUID()}`, body: null });
      const value = schema.parse({
        ...identity,
        version: 1,
        createdAt: new Date().toISOString(),
        backupName: `pre-update-${randomUUID()}`,
        steps: { backup: step(), preview: step(), apply: step() },
      });
      const fd = openSync(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(dirname(this.path));
      return value;
    });
  }
  async change(edit: (value: SystemUpdateReceipt) => void): Promise<SystemUpdateReceipt> {
    return this.locked(() => {
      const value = this.read();
      edit(value);
      const raw = JSON.stringify(schema.parse(value));
      if (Buffer.byteLength(raw) > 128 * 1024) throw Error("Update receipt limit exceeded");
      atomicWrite(this.path, raw);
      return value;
    });
  }
  async freeze(
    step: UpdateStep,
    body: NonNullable<SystemUpdateReceipt["steps"]["backup"]["body"]>,
  ): Promise<SystemUpdateReceipt> {
    return this.change((value) => {
      const before = value.steps[step].body;
      if (before !== null && JSON.stringify(before) !== JSON.stringify(body))
        throw Error("Request body is frozen; receipt identity changed");
      value.steps[step].body = body;
    });
  }
}
