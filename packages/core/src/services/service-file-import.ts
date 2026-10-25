import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import z from "zod/v4";
import { fsyncDirectory } from "../release-files";
import { agentStatePaths, writeAgentStateFile } from "./agent-state";
import {
  ownedDirectoryProblem,
  type ReleaseServiceFiles,
  readOwnedRegularFile,
  ServiceFileError,
  serviceFileReferences,
  sha256,
} from "./release-service-files";
import {
  addOverrideRecords,
  overridableWithoutRelease,
  overridesDirectory,
} from "./service-overrides";
import type { LoadedService } from "./types";

/**
 * The one-time import of an operator's edits in the checkout's service files
 * into overrides, when render first uses the release's files.
 *
 * A checkout file is an edit when its bytes match no version that file had
 * in a release: a checkout the panel updated still holds an earlier
 * release's files, which are not edits. A file a container writes (a
 * `writableCopy`, valhalla.json) is never imported. Traefik's dynamic YAML
 * and TOML files the release doesn't ship (an operator's `auth.yml`) are,
 * and its `traefik.yml` when it differs (the `basic-auth@file` reference);
 * the routes earlier releases wrote there never are.
 *
 * Nothing in the checkout is moved or changed. A differing file render may
 * not read fails the render, with nothing recorded, rather than lose the
 * edit. Afterwards the import is recorded and never runs again; render goes
 * on reporting checkout edits that are not overrides.
 */

const MARKER = "overrides-import.json";
const markerSchema = z.strictObject({
  version: z.literal(1),
  importedAt: z.string(),
  imported: z.array(z.string()),
});

function markerPath(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, MARKER);
}

/** Whether the import has run (the checkout's edits are overrides now, or there were none). */
export function serviceFilesImported(infraDir: string): boolean {
  try {
    markerSchema.parse(JSON.parse(readFileSync(markerPath(infraDir), "utf8")));
    return true;
  } catch {
    return false;
  }
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Each release file a container doesn't write, and Traefik's dynamic files the checkout adds. */
function importCandidates(
  rootDir: string,
  services: readonly LoadedService[],
  release: ReleaseServiceFiles,
  uid: number,
): string[] {
  const written = new Set(
    serviceFileReferences(services.filter((service) => service.isBuiltIn).map((s) => s.manifest))
      .filter((reference) => reference.writableCopy)
      .map((reference) => `${reference.serviceId}/${reference.path}`),
  );
  const keys = [...release.files.keys()].filter((key) => !written.has(key));
  const dynamic = join(rootDir, "services", "traefik", "config", "dynamic");
  const stats = lstatOrUndefined(dynamic);
  if (stats) {
    const problem = ownedDirectoryProblem(stats, uid);
    if (problem) {
      throw new ServiceFileError(
        `services/traefik/config/dynamic can't be read for the one-time import of your service file edits: ${problem}. Make it your own directory, or remove it, and render again.`,
      );
    }
    for (const name of readdirSync(dynamic).sort()) {
      const key = `traefik/config/dynamic/${name}`;
      if (
        overridableWithoutRelease("traefik", `config/dynamic/${name}`) &&
        !release.files.has(key)
      ) {
        keys.push(key);
      }
    }
  }
  return keys.sort();
}

function writeOverride(path: string, bytes: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.import.tmp`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

/**
 * Imports the checkout's edits once, when `release` is the release's own
 * files. Returns the imported files (`<id>/<path>`), or null when the import
 * already ran or does not apply (running the checkout's files).
 */
export function importCheckoutServiceFiles(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  uid?: number;
}): string[] | null {
  const { infraDir, services, release } = options;
  if (release.origin !== "release" || serviceFilesImported(infraDir)) return null;
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const rootDir = resolve(infraDir, "..", "..");
  const overrides = overridesDirectory(infraDir);
  const edits: Array<{ key: string; bytes: Buffer; mode: number }> = [];
  for (const key of importCandidates(rootDir, services, release, uid)) {
    if (existsSync(join(overrides, key)) || lstatOrUndefined(join(overrides, key))) continue;
    const path = join(rootDir, "services", key);
    if (!lstatOrUndefined(path)) continue;
    const read = readOwnedRegularFile(path, uid);
    if ("reason" in read) {
      throw new ServiceFileError(
        `services/${key} can't be read for the one-time import of your service file edits: ${read.reason}. Render now uses the release's files, so an edit there would be lost: replace it with a regular file of yours holding your version, or delete it if the release's version will do (git restore services/${key}), and render again.`,
      );
    }
    const hash = sha256(read.bytes);
    const known = release.history.get(key) ?? new Set<string>();
    if (hash === release.files.get(key)?.sha256 || known.has(hash)) continue;
    // Never more open than the checkout's file, and never writable by others;
    // an operator's Traefik files may hold password hashes, so owner-only.
    const mode = read.mode & (key.startsWith("traefik/") ? 0o600 : 0o644);
    edits.push({ key, bytes: read.bytes, mode: mode | 0o400 });
  }
  const records: Record<string, { override: string; base: string | null }> = {};
  for (const { key, bytes, mode } of edits) {
    writeOverride(join(overrides, key), bytes, mode);
    records[key] = { override: sha256(bytes), base: release.files.get(key)?.sha256 ?? null };
  }
  if (edits.length > 0) addOverrideRecords(infraDir, records);
  const imported = edits.map((edit) => edit.key);
  writeAgentStateFile(
    infraDir,
    MARKER,
    `${JSON.stringify({ version: 1, importedAt: new Date().toISOString(), imported })}\n`,
  );
  return imported;
}

/** Said once, when the import made overrides of the checkout's edits. */
export function describeImportedServiceFiles(imported: readonly string[]): string[] {
  if (imported.length === 0) return [];
  return [
    `Imported ${imported.length} checkout service file${imported.length === 1 ? "" : "s"} that differ from every version a release shipped as overrides, used from now on in place of the release's: ${imported.map((key) => `infra/docker/overrides/services/${key}`).join(", ")}. Edit them there; the checkout's copies are no longer read.`,
  ];
}

/**
 * Checkout service files that differ from every version a release shipped
 * and that no override carries: an edit render does not use. Unreadable
 * files are left out; the import reported them.
 */
export function unusedCheckoutEdits(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  overrides: ReadonlyMap<string, Buffer>;
  uid?: number;
}): string[] {
  const { infraDir, services, release, overrides } = options;
  if (release.origin !== "release") return [];
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const rootDir = resolve(infraDir, "..", "..");
  let candidates: string[];
  try {
    candidates = importCandidates(rootDir, services, release, uid);
  } catch {
    return [];
  }
  const unused: string[] = [];
  for (const key of candidates) {
    const read = readOwnedRegularFile(join(rootDir, "services", key), uid);
    if ("reason" in read) continue;
    const hash = sha256(read.bytes);
    if (hash === release.files.get(key)?.sha256 || release.history.get(key)?.has(hash)) continue;
    if (overrides.get(key)?.equals(read.bytes)) continue;
    unused.push(key);
  }
  return unused;
}

export function describeUnusedCheckoutEdits(keys: readonly string[]): string[] {
  return keys.map(
    (key) =>
      `services/${key} differs from every version a release shipped, and render does not use it: services read the release's files, or your overrides. To keep this change, put the whole file in infra/docker/overrides/services/${key}.`,
  );
}
