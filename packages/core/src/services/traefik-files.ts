import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
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
import { join } from "node:path";
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
 * Its files are the release's `services/traefik/config` (from the agent's
 * runtime bundle, or the checkout when running from source), with an
 * operator's overrides in their place: `traefik.yml`, and each YAML or TOML
 * file of `dynamic/` (the release's `middlewares.yml`, and an operator's
 * `auth.yml`), beside the rendered routes.
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
const FILE_MODE = 0o600;

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
 * Brings the agent's Traefik dynamic directory to `files` (by name) and the
 * rendered routes, each replaced atomically. A file no longer among them is
 * removed, and so is a temporary a stopped render left.
 */
export function writeTraefikDynamicDirectory(
  infraDir: string,
  files: ReadonlyMap<string, Buffer>,
  routes: string,
): void {
  const target = ensureTraefikDynamicDirectory(infraDir);
  for (const [name, bytes] of files) replaceFile(target, name, bytes);
  replaceFile(target, TRAEFIK_ROUTES_FILE, Buffer.from(routes));
  for (const name of readdirSync(target)) {
    const stale =
      TEMPORARY_FILE.test(name) ||
      (DYNAMIC_FILE.test(name) && name !== TRAEFIK_ROUTES_FILE && !files.has(name));
    if (stale) rmSync(join(target, name), { recursive: true, force: true });
  }
  fsyncDirectory(target);
}
