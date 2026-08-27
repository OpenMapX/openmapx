import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MAX_BYTES = 64 * 1024;
const MAX_SERVICES = 64;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INCIDENT_ID = /^recovery_[a-f0-9]{64}$/;
const TEMPORARY = /^\.runtime-recovery-v1\.json\.[a-f0-9]{24}\.tmp$/;
const MAX_TEMPORARIES = 16;

export interface RuntimeRecoveryRecord {
  version: 1;
  incidentId: string;
  orphanedServiceIds: string[];
  restartServiceIds: string[];
}

export interface RuntimeRecoveryJournal {
  record(): RuntimeRecoveryRecord | null;
  replace(record: RuntimeRecoveryRecord): Promise<void>;
  clear(): Promise<void>;
}

export function mergeRuntimeRecovery(
  retained: RuntimeRecoveryRecord | null,
  discovered: RuntimeRecoveryRecord,
): RuntimeRecoveryRecord {
  return {
    version: 1,
    incidentId: retained?.incidentId ?? discovered.incidentId,
    orphanedServiceIds: [
      ...new Set([...(retained?.orphanedServiceIds ?? []), ...discovered.orphanedServiceIds]),
    ].sort(),
    restartServiceIds: [
      ...new Set([...(retained?.restartServiceIds ?? []), ...discovered.restartServiceIds]),
    ].sort(),
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function parseServiceIds(value: unknown, forbidden: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > MAX_SERVICES) throw new Error("invalid");
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !SERVICE_ID.test(entry) || forbidden.has(entry)) {
      throw new Error("invalid");
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length || [...ids].sort().some((id, index) => id !== ids[index])) {
    throw new Error("invalid");
  }
  return ids;
}

function parseRecord(
  value: unknown,
  forbidden: ReadonlySet<string> = new Set<string>(),
): RuntimeRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const raw = value as Record<string, unknown>;
  if (
    !exactKeys(raw, ["version", "incidentId", "orphanedServiceIds", "restartServiceIds"]) ||
    raw.version !== 1 ||
    typeof raw.incidentId !== "string" ||
    !INCIDENT_ID.test(raw.incidentId)
  ) {
    throw new Error("invalid");
  }
  return {
    version: 1,
    incidentId: raw.incidentId,
    orphanedServiceIds: parseServiceIds(raw.orphanedServiceIds, forbidden),
    restartServiceIds: parseServiceIds(raw.restartServiceIds, forbidden),
  };
}

async function syncDirectory(directory: string, expectedUid: number): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new Error("invalid");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeRead(path: string, expectedUid: number): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > MAX_BYTES
    ) {
      throw new Error();
    }
    const bytes = Buffer.alloc(metadata.size);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== bytes.length) throw new Error();
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseFile(
  bytes: Uint8Array,
  forbidden: ReadonlySet<string>,
): RuntimeRecoveryRecord | null {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ["version", "recovery"]) || raw.version !== 1) throw new Error("invalid");
  return raw.recovery === null ? null : parseRecord(raw.recovery, forbidden);
}

export async function openRuntimeRecoveryJournal(
  path: string,
  options: { forbiddenServiceIds?: Iterable<string>; expectedUid?: number } = {},
): Promise<RuntimeRecoveryJournal> {
  if (basename(path) !== "runtime-recovery-v1.json") {
    throw new Error("Runtime recovery journal is unavailable");
  }
  const directory = dirname(path);
  const expectedUid = options.expectedUid ?? process.geteuid?.() ?? process.getuid?.() ?? 0;
  const forbidden = new Set(options.forbiddenServiceIds ?? []);
  let current: RuntimeRecoveryRecord | null = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(directory, expectedUid);
    const handle = await opendir(directory);
    const temporaries: string[] = [];
    try {
      for await (const entry of handle) {
        if (!TEMPORARY.test(entry.name)) continue;
        temporaries.push(entry.name);
        if (temporaries.length > MAX_TEMPORARIES) throw new Error("invalid");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    for (const name of temporaries) await safeRead(join(directory, name), expectedUid);
    for (const name of temporaries) await unlink(join(directory, name));
    if (temporaries.length > 0) await syncDirectory(directory, expectedUid);
    const bytes = await safeRead(path, expectedUid);
    if (bytes) current = parseFile(bytes, forbidden);
  } catch {
    throw new Error("Runtime recovery journal is unavailable");
  }
  let chain = Promise.resolve();

  const write = async (record: RuntimeRecoveryRecord | null): Promise<void> => {
    const validated = record === null ? null : parseRecord(record, forbidden);
    const bytes = Buffer.from(JSON.stringify({ version: 1, recovery: validated }), "utf8");
    if (bytes.byteLength > MAX_BYTES) throw new Error("Runtime recovery journal capacity exceeded");
    const temporary = join(
      directory,
      `.runtime-recovery-v1.json.${randomBytes(12).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      renamed = true;
      await syncDirectory(directory, expectedUid);
      current = validated === null ? null : structuredClone(validated);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  };

  const enqueue = (record: RuntimeRecoveryRecord | null): Promise<void> => {
    const snapshot = record === null ? null : structuredClone(record);
    const next = chain.then(() => write(snapshot));
    chain = next.catch(() => undefined);
    return next;
  };
  try {
    await enqueue(current);
  } catch {
    throw new Error("Runtime recovery journal is unavailable");
  }
  return {
    record: () => (current === null ? null : structuredClone(current)),
    replace: (record) => enqueue(record),
    clear: () => enqueue(null),
  };
}
