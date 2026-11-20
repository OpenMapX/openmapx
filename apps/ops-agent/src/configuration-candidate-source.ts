import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  inspectPreparedConfigurationRecord,
  opsOperationSchema,
  type PreparedConfigurationRecord,
} from "@openmapx/core/ops";
import { atomicWrite } from "@openmapx/core/release-files";
import { services } from "@openmapx/core/server";

/** The agent's own store of prepared configuration candidates, one file per apply key. */
export interface ConfigurationCandidateSource {
  directory: string;
}

const MAX_CANDIDATES = 128;
const FILE = /^opk1_[A-Za-z0-9_-]{16,64}\.json$/;

export function configurationCandidateSource(infraDir: string): ConfigurationCandidateSource {
  return { directory: services.agentStatePaths(infraDir).configurationCandidates };
}

function names(source: ConfigurationCandidateSource): string[] {
  try {
    return readdirSync(source.directory).filter((name) => FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function readFile(source: ConfigurationCandidateSource, name: string) {
  const inspected = inspectPreparedConfigurationRecord(
    JSON.parse(readFileSync(join(source.directory, name), "utf8")),
  );
  if (`${inspected.record.operationKey}.json` !== name)
    throw Error("Configuration candidate unavailable");
  return inspected;
}

/** Keeps a candidate until it is discarded; the same key with another record is refused. */
export function retainConfigurationCandidate(
  source: ConfigurationCandidateSource,
  record: PreparedConfigurationRecord,
): void {
  const inspected = inspectPreparedConfigurationRecord(record);
  const name = `${inspected.record.operationKey}.json`;
  const existing = names(source);
  if (existing.includes(name)) {
    if (canonicalJson(readFile(source, name).record) !== canonicalJson(inspected.record))
      throw Error("Configuration candidate identity conflict");
    return;
  }
  if (existing.length >= MAX_CANDIDATES) throw Error("Configuration candidate capacity exceeded");
  for (const other of existing)
    if (readFile(source, other).record.candidateId === inspected.record.candidateId)
      throw Error("Configuration candidate identity conflict");
  mkdirSync(source.directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(source.directory, name), `${JSON.stringify(inspected.record)}\n`);
}

export function readConfigurationCandidateRecord(
  source: ConfigurationCandidateSource,
  lookup: { operationKey: string } | { candidateId: string },
): PreparedConfigurationRecord | null {
  if ("operationKey" in lookup) {
    const name = `${lookup.operationKey}.json`;
    return names(source).includes(name) ? readFile(source, name).record : null;
  }
  const matches = names(source)
    .map((name) => readFile(source, name).record)
    .filter((record) => record.candidateId === lookup.candidateId);
  if (matches.length > 1) throw Error("Configuration candidate identity conflict");
  return matches[0] ?? null;
}

export async function discardConfigurationCandidate(
  source: ConfigurationCandidateSource,
  operationKey: string,
): Promise<boolean> {
  const name = `${operationKey}.json`;
  if (!names(source).includes(name)) return false;
  await unlink(join(source.directory, name));
  return true;
}

/** The candidate with its apply operation and payload, by candidate id. */
export async function readConfigurationCandidate(
  source: ConfigurationCandidateSource,
  candidateId: string,
) {
  const record = readConfigurationCandidateRecord(source, { candidateId });
  if (!record) throw Error("Configuration candidate missing");
  const inspected = inspectPreparedConfigurationRecord(record);
  return { ...inspected, operation: opsOperationSchema.parse(inspected.record.operation) };
}
