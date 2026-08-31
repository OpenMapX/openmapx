import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AtomicWriteDurability = "visibility" | "full";

export interface AtomicWriteOptions {
  durability: AtomicWriteDurability;
  mode?: number;
  createParentDirectory?: boolean;
}

function temporaryPath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
}

export function atomicWriteFileSync(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions,
): void {
  if (options.createParentDirectory) mkdirSync(dirname(targetPath), { recursive: true });
  const temporary = temporaryPath(targetPath);
  let ownsTemporary = false;
  try {
    const descriptor = openSync(temporary, "wx", options.mode);
    ownsTemporary = true;
    try {
      writeFileSync(descriptor, data);
      if (options.durability === "full") fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, targetPath);
    ownsTemporary = false;
    if (options.durability === "full") {
      const directory = openSync(dirname(targetPath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (ownsTemporary) rmSync(temporary, { force: true });
  }
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  if (options.createParentDirectory) await mkdir(dirname(targetPath), { recursive: true });
  const temporary = temporaryPath(targetPath);
  let ownsTemporary = false;
  try {
    const file = await open(temporary, "wx", options.mode);
    ownsTemporary = true;
    try {
      await file.writeFile(data);
      if (options.durability === "full") await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, targetPath);
    ownsTemporary = false;
    if (options.durability === "full") {
      const directory = await open(dirname(targetPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true });
  }
}

export function atomicWriteJsonSync(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions,
): void {
  atomicWriteFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}
