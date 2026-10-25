import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fsyncDirectory } from "../release-files";
import { ensureTraefikDynamicDirectory } from "./agent-state";

/**
 * Traefik's configuration outside the checkout. Traefik watches its dynamic
 * directory and reloads a file as soon as it changes, so that directory is a
 * stable one in the agent's state, `infra/docker/state/ops-agent/traefik/dynamic`,
 * not one inside a configuration generation, which a running Traefik would
 * keep seeing after the next commit. Its static `traefik.yml`, read only at
 * start, goes into the generation.
 *
 * Until the release supplies these files itself, their bytes come from the
 * checkout's `services/traefik/config`, as every service file still does:
 * `traefik.yml` and each YAML or TOML file of `dynamic/` (the release's
 * `middlewares.yml`, and an operator's `auth.yml`), beside the rendered routes.
 * Only a regular file of the deployment's user with one link, in directories
 * of that user, is read, never through a link; anything else is skipped and
 * reported by name, and the copy an earlier render made of it stays.
 *
 * Traefik's image runs as root, which reads the owner-only files of the
 * deployment's user through the capabilities Docker grants by default, so
 * every copy is owner-only, `auth.yml`'s password hashes included.
 */

export const TRAEFIK_ROUTES_FILE = "generated-routes.yml";
/** `traefik.yml`'s place in a configuration generation. */
export const TRAEFIK_STATIC_GENERATION_FILE = "traefik/traefik.yml";
const DYNAMIC_FILE = /\.(?:ya?ml|toml)$/;
/** The temporaries `replaceFile` writes; one a stopped render left is removed by the next. */
const TEMPORARY_FILE = /^\..+\.[0-9a-f]{12}\.tmp$/;
const MAX_TRAEFIK_FILE_BYTES = 1024 * 1024;
const FILE_MODE = 0o600;

/** Where releases before this one wrote the routes, and Traefik still reads them until it is recreated. */
export function legacyTraefikDynamicDirectory(infraDir: string): string {
  return join(resolve(infraDir, "..", ".."), "services", "traefik", "config", "dynamic");
}

/** The checkout's Traefik configuration, the source of the copies. */
export function traefikConfigDirectory(serviceDirectory: string): string {
  return join(serviceDirectory, "config");
}

/** Why a source directory may not be read, or null when it may. */
function directoryProblem(stats: Stats | undefined, uid: number): string | null {
  if (!stats) return "it is missing";
  if (stats.isSymbolicLink()) return "it is a symbolic link";
  if (!stats.isDirectory()) return "it is not a directory";
  if (stats.uid !== uid) return `it belongs to uid ${stats.uid}, not ${uid}`;
  return null;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A file's bytes, read without following a link, or why it isn't read. */
function readOwnedFile(path: string, uid: number): { bytes: Buffer } | { reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { reason: "it is a symbolic link" };
    if (code === "ENOENT") return { reason: "it is missing" };
    if (code === "EACCES") return { reason: "it can't be read" };
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "it is not a regular file" };
    if (stats.uid !== uid) return { reason: `it belongs to uid ${stats.uid}, not ${uid}` };
    if (stats.nlink !== 1) return { reason: `it has ${stats.nlink} links` };
    if (stats.size > MAX_TRAEFIK_FILE_BYTES) return { reason: "it is larger than 1 MiB" };
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** The bytes of `traefik.yml` for a generation; refuses one it may not read. */
export function readTraefikStaticConfiguration(serviceDirectory: string, uid: number): Buffer {
  const config = traefikConfigDirectory(serviceDirectory);
  const problem = directoryProblem(lstatOrUndefined(config), uid);
  if (problem) throw new Error(`services/traefik/config can't be used: ${problem}`);
  const read = readOwnedFile(join(config, "traefik.yml"), uid);
  if ("reason" in read) {
    throw new Error(`services/traefik/config/traefik.yml can't be used: ${read.reason}`);
  }
  return read.bytes;
}

export interface TraefikDynamicSources {
  files: Map<string, Buffer>;
  /**
   * Files Traefik would load that are not copied, and why, by their path in
   * `services/traefik/config`; names only. `dynamic` itself when the
   * directory may not be read, and then nothing of it is known.
   */
  skipped: Array<{ name: string; reason: string }>;
  /** Every file Traefik would load that the checkout has, copied or not; null when it may not be listed. */
  present: Set<string> | null;
}

/**
 * The files of the checkout's `dynamic/` Traefik would load. The routes an
 * earlier release wrote there are never taken; files Traefik ignores (such as
 * `auth.yml.example`) are left out.
 */
export function readTraefikDynamicSources(
  serviceDirectory: string,
  uid: number,
): TraefikDynamicSources {
  const config = traefikConfigDirectory(serviceDirectory);
  const source = join(config, "dynamic");
  const files = new Map<string, Buffer>();
  const unreadable = (name: string, reason: string): TraefikDynamicSources => ({
    files,
    skipped: [{ name, reason }],
    present: null,
  });
  const configProblem = directoryProblem(lstatOrUndefined(config), uid);
  if (configProblem) return unreadable("", configProblem);
  const before = lstatOrUndefined(source);
  const sourceProblem = directoryProblem(before, uid);
  if (sourceProblem || !before) return unreadable("dynamic", sourceProblem ?? "it is missing");
  const skipped: TraefikDynamicSources["skipped"] = [];
  const present = new Set<string>();
  for (const name of readdirSync(source).sort()) {
    if (name === TRAEFIK_ROUTES_FILE || !DYNAMIC_FILE.test(name) || name.startsWith(".")) continue;
    present.add(name);
    const read = readOwnedFile(join(source, name), uid);
    if ("reason" in read) skipped.push({ name: `dynamic/${name}`, reason: read.reason });
    else files.set(name, read.bytes);
  }
  // The directory read is the one checked, not one swapped in meanwhile.
  const after = lstatOrUndefined(source);
  if (!after || after.ino !== before.ino || after.dev !== before.dev) {
    files.clear();
    return unreadable("dynamic", "it changed while it was read");
  }
  return { files, skipped, present };
}

/** Writes `bytes` to a new temporary in `directory`, durably; removes it when that fails. */
function writeTemporary(directory: string, name: string, bytes: Buffer, mode: number): string {
  const temporary = join(directory, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  return temporary;
}

/**
 * Replaces `path` with `bytes` through a temporary in the same directory, so
 * a reader sees the whole old file or the whole new one. The temporary's name
 * ends in neither `.yml` nor `.toml`: Traefik does not load it.
 */
function replaceFile(directory: string, name: string, bytes: Buffer): void {
  const path = join(directory, name);
  const current = lstatOrUndefined(path);
  if (
    current?.isFile() &&
    (current.mode & 0o777) === FILE_MODE &&
    readFileSync(path).equals(bytes)
  ) {
    return;
  }
  const temporary = writeTemporary(directory, name, bytes, FILE_MODE);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Brings the agent's Traefik dynamic directory to the checkout's dynamic files
 * and the rendered routes, each replaced atomically. A file removed from the
 * checkout is removed here; one that is there but skipped keeps the copy an
 * earlier render made, and so does everything when the checkout's directory
 * may not be listed. Returns what it skipped.
 */
export function writeTraefikDynamicDirectory(
  infraDir: string,
  serviceDirectory: string,
  routes: string,
  uid: number,
): TraefikDynamicSources["skipped"] {
  const target = ensureTraefikDynamicDirectory(infraDir);
  const { files, skipped, present } = readTraefikDynamicSources(serviceDirectory, uid);
  for (const [name, bytes] of files) replaceFile(target, name, bytes);
  replaceFile(target, TRAEFIK_ROUTES_FILE, Buffer.from(routes));
  for (const name of readdirSync(target)) {
    const stale =
      TEMPORARY_FILE.test(name) ||
      (present !== null &&
        DYNAMIC_FILE.test(name) &&
        name !== TRAEFIK_ROUTES_FILE &&
        !present.has(name));
    if (stale) rmSync(join(target, name), { recursive: true, force: true });
  }
  fsyncDirectory(target);
  return skipped;
}

/**
 * Writes the routes where an earlier release kept them, for a Traefik not yet
 * recreated, and returns what to report when that fails; the render goes on.
 * A directory that isn't there is mounted by no one and is not created.
 */
export function writeLegacyTraefikRoutes(infraDir: string, routes: string): string | null {
  const directory = legacyTraefikDynamicDirectory(infraDir);
  const failed = (reason: string) =>
    `The routes could not be written to services/traefik/config/dynamic, where a Traefik started by an earlier release still reads them: ${reason}. That Traefik keeps the routes of an earlier render. Recreate Traefik so it reads infra/docker/state/ops-agent/traefik/dynamic: pnpm openmapx services update traefik, or Recreate on Admin → Services → Traefik.`;
  const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "an unexpected error";
  let stats: Stats | undefined;
  try {
    stats = lstatOrUndefined(directory);
  } catch (error) {
    return failed(code(error));
  }
  if (!stats) return null;
  if (!stats.isDirectory()) return failed("it is not a directory");
  let temporary: string | undefined;
  try {
    temporary = writeTemporary(directory, TRAEFIK_ROUTES_FILE, Buffer.from(routes), 0o644);
    renameSync(temporary, join(directory, TRAEFIK_ROUTES_FILE));
    return null;
  } catch (error) {
    if (temporary) rmSync(temporary, { force: true });
    return failed(code(error));
  }
}

/** One line per dynamic file left out, names only, for render, check and the agent's log. */
export function describeSkippedTraefikFiles(skipped: TraefikDynamicSources["skipped"]): string[] {
  return skipped.map(({ name, reason }) => {
    const path = name ? `services/traefik/config/${name}` : "services/traefik/config";
    return `${path} was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: ${reason}. Traefik keeps the copy of an earlier render, if there is one.`;
  });
}

/** Said while a container still mounts the checkout's dynamic directory. */
export const LEGACY_TRAEFIK_MOUNT_NOTICE =
  "Traefik still reads its routes from services/traefik/config/dynamic, where render keeps writing them until no container mounts that directory. Recreate Traefik to move it to infra/docker/state/ops-agent/traefik/dynamic: pnpm openmapx services update traefik, or Recreate on Admin → Services → Traefik. That restarts the proxy for a few seconds.";
