import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectPreparedConfigurationRecord,
  openTrustedConfigurationSnapshot,
  opsOperationFingerprint,
  opsOperationSchema,
} from "@openmapx/core/ops";

export interface ConfigurationCandidateSource {
  directory: string;
  token: string;
  ownerUid: number;
  ownerGid: number;
}
/** Reads only the fixed bounded candidate namespace, never a request path. */
export async function readRetainedConfigurationCandidate(
  source: ConfigurationCandidateSource,
  candidateId: string,
) {
  const directory = join(source.directory, ".candidates");
  const dir = await lstat(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== source.ownerUid ||
    dir.gid !== source.ownerGid ||
    (dir.mode & 0o777) !== 0o700
  )
    throw Error("Configuration candidate unavailable");
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 128) throw Error("Configuration candidate unavailable");
  let match: ReturnType<typeof inspectPreparedConfigurationRecord> | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !/^opk1_[A-Za-z0-9_-]{16,64}\.json$/.test(entry.name))
      throw Error("Configuration candidate unavailable");
    const path = join(directory, entry.name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(),
        current = await lstat(path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== source.ownerUid ||
        before.gid !== source.ownerGid ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > 768 * 1024 ||
        before.dev !== current.dev ||
        before.ino !== current.ino
      )
        throw Error("Configuration candidate unavailable");
      const inspected = inspectPreparedConfigurationRecord(await handle.readFile(), source.token);
      const after = await handle.stat(),
        latest = await lstat(path);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.dev !== latest.dev ||
        before.ino !== latest.ino ||
        `${inspected.record.operationKey}.json` !== entry.name
      )
        throw Error("Configuration candidate unavailable");
      if (inspected.record.candidateId === candidateId) {
        if (match) throw Error("Configuration candidate identity conflict");
        match = inspected;
      }
    } finally {
      await handle.close();
    }
  }
  if (!match) throw Error("Configuration candidate missing");
  const operation = opsOperationSchema.parse(match.record.operation);
  if (
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(operation.kind)
  )
    throw Error("Configuration candidate typed kind rejected");
  // Authenticated historical metadata only. It cannot open a payload, consume
  // a claim or renew the original seal; NoGuard recovery may observe expiry.
  return { ...match, operation };
}
export async function readConfigurationCandidate(
  source: ConfigurationCandidateSource,
  candidateId: string,
) {
  const match = await readRetainedConfigurationCandidate(source, candidateId),
    operation = match.operation;
  const { payload } = openTrustedConfigurationSnapshot(match.sealed, {
    role: "api",
    token: source.token,
    operationKey: match.record.operationKey,
    operation,
    fingerprint: opsOperationFingerprint(operation),
  });
  return { ...match, operation, payload };
}
