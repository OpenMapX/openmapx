import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
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
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import z from "zod/v4";
import { fsyncDirectory } from "../release-files";
import { agentStatePaths } from "./agent-state";
import {
  type ReleaseServiceFiles,
  releaseFilesAt,
  ServiceFileError,
  serviceFileReferences,
  sha256,
} from "./release-service-files";
import type { LoadedService } from "./types";

/**
 * The service files a generation's containers mount, kept beside the
 * generations in immutable, content-addressed trees:
 * `infra/docker/state/ops-agent/service-files/<id>/<sha256>/<path>`.
 *
 * Not inside the generation: a generation's directories must be 0700 and its
 * files 0400 or 0600 for the releases before this one, which a rollback runs,
 * and containers running as neither root nor the deployment's user (PostGIS
 * as 999, nginx's workers) need files they can read (0444, scripts 0555) and
 * directories they can enter (0755). Docker mounts the file or directory
 * itself, so the 0700 directories above it don't stand in their way.
 *
 * A tree's name is the hash of what it holds, so a render whose files did not
 * change mounts the same path, Compose recreates nothing for it, and one whose
 * files changed mounts a new path, so `compose up` recreates exactly the
 * services that need it. The generation records which trees it uses.
 */

export const SERVICE_FILES_GENERATION_FILE = "service-files.json";
/** Any container user may enter a tree's directories and read its files; only scripts run. */
const DIRECTORY_MODE = 0o755;
const fileMode = (file: ServiceFileTreeEntry) => (file.executable ? 0o555 : 0o444);
const TREE = /^[a-f0-9]{64}$/;
const TEMPORARY_TREE = /^\.[a-f0-9]{64}\.[a-f0-9]{12}\.tmp$/;

export interface ServiceFileTreeEntry {
  readonly path: string;
  readonly bytes: Buffer;
  readonly executable: boolean;
}

export interface ServiceFileTree {
  readonly serviceId: string;
  readonly hash: string;
  /** Sorted by path. */
  readonly files: readonly ServiceFileTreeEntry[];
}

export interface WritableCopySeed {
  readonly serviceId: string;
  /** The release's path of the file in the service's directory. */
  readonly path: string;
  /** `@infra:data/...`. */
  readonly copy: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface ResolvedServiceFiles {
  readonly set: ReleaseServiceFiles;
  /** By service ID, for every built-in whose own or another's mounts name its files. */
  readonly trees: ReadonlyMap<string, ServiceFileTree>;
  readonly writableCopies: readonly WritableCopySeed[];
  /** Traefik's static configuration, and the files of its dynamic directory by name. */
  readonly traefik: {
    readonly staticConfiguration: Buffer | null;
    readonly dynamic: ReadonlyMap<string, Buffer>;
  };
}

/** Replacement bytes by `<serviceId>/<path>`, and Traefik dynamic files the release doesn't ship. */
export interface ServiceFileOverlay {
  readonly files: ReadonlyMap<string, Buffer>;
}

const TRAEFIK_DYNAMIC = "config/dynamic/";
const DYNAMIC_FILE = /^[^/]+\.(?:ya?ml|toml)$/;

export function serviceFileTreeHash(files: readonly ServiceFileTreeEntry[]): string {
  const hash = createHash("sha256").update("openmapx-service-files-v1\0");
  for (const file of files) {
    hash
      .update(file.path)
      .update("\0")
      .update(file.executable ? "x" : "-")
      .update("\0")
      .update(sha256(file.bytes))
      .update("\0");
  }
  return hash.digest("hex");
}

/**
 * What a generation mounts and reads from `set`, with `overlay`'s files in
 * place of the release's: a tree per built-in whose files a mount names, the
 * seeds of writable copies, and Traefik's configuration.
 */
export function resolveServiceFiles(
  services: readonly LoadedService[],
  set: ReleaseServiceFiles,
  overlay: ServiceFileOverlay = { files: new Map() },
): ResolvedServiceFiles {
  const builtIns = services.filter((service) => service.isBuiltIn);
  const references = serviceFileReferences(builtIns.map((service) => service.manifest));
  const missing = new Set(set.missing);
  const effective = (key: string, bytes: Buffer) => overlay.files.get(key) ?? bytes;
  const byService = new Map<string, Map<string, ServiceFileTreeEntry>>();
  const writableCopies: WritableCopySeed[] = [];
  for (const reference of references) {
    const key = `${reference.serviceId}/${reference.path}`;
    if (!reference.mounted) continue;
    const files = releaseFilesAt(set, reference.serviceId, reference.path);
    if (files.length === 0) {
      if (set.origin === "release" || !missing.has(key)) {
        throw new ServiceFileError(`The release has no services/${key}, which a mount names`);
      }
      // Mounted from the checkout as before, which render warns about.
      continue;
    }
    if (reference.writableCopy) {
      const [file] = files;
      if (files.length !== 1 || !file || file.path !== reference.path) {
        throw new ServiceFileError(`services/${key} has a writable copy, so it must be one file`);
      }
      const bytes = effective(key, file.bytes);
      writableCopies.push({
        serviceId: reference.serviceId,
        path: reference.path,
        copy: reference.writableCopy,
        bytes,
        sha256: sha256(bytes),
      });
      continue;
    }
    const tree = byService.get(reference.serviceId) ?? new Map<string, ServiceFileTreeEntry>();
    byService.set(reference.serviceId, tree);
    for (const file of files) {
      tree.set(file.path, {
        path: file.path,
        executable: file.executable,
        bytes: effective(`${file.serviceId}/${file.path}`, file.bytes),
      });
    }
  }
  const trees = new Map<string, ServiceFileTree>();
  for (const [serviceId, entries] of [...byService].sort(([a], [b]) => a.localeCompare(b))) {
    const files = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    trees.set(serviceId, { serviceId, hash: serviceFileTreeHash(files), files });
  }
  const traefikStatic = set.files.get("traefik/config/traefik.yml");
  const dynamic = new Map<string, Buffer>();
  for (const file of releaseFilesAt(set, "traefik", "config/dynamic")) {
    const name = file.path.slice(TRAEFIK_DYNAMIC.length);
    if (DYNAMIC_FILE.test(name) && name !== "generated-routes.yml") {
      dynamic.set(name, effective(`traefik/${file.path}`, file.bytes));
    }
  }
  for (const [key, bytes] of overlay.files) {
    const name = key.startsWith(`traefik/${TRAEFIK_DYNAMIC}`)
      ? key.slice(`traefik/${TRAEFIK_DYNAMIC}`.length)
      : null;
    if (name && DYNAMIC_FILE.test(name) && name !== "generated-routes.yml")
      dynamic.set(name, bytes);
  }
  return {
    set,
    trees,
    writableCopies,
    traefik: {
      staticConfiguration: traefikStatic
        ? effective("traefik/config/traefik.yml", traefikStatic.bytes)
        : null,
      dynamic,
    },
  };
}

/** Where the store keeps its trees. */
export function serviceFileStore(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, "service-files");
}

export function serviceFileTreePath(infraDir: string, serviceId: string, hash: string): string {
  return join(serviceFileStore(infraDir), serviceId, hash);
}

/** The path a mount of `path` uses in `tree`, or undefined when the tree doesn't hold it. */
export function pathInServiceFileTree(
  tree: ServiceFileTree,
  directory: string,
  path: string,
): string | undefined {
  const normalized = posix.normalize(path);
  const holds = tree.files.some(
    (file) => file.path === normalized || file.path.startsWith(`${normalized}/`),
  );
  return holds ? join(directory, ...normalized.split("/")) : undefined;
}

function ownDirectory(path: string, uid: number): void {
  let stats: Stats | undefined;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    stats = lstatSync(path);
  }
  if (!stats.isDirectory() || stats.uid !== uid) {
    throw new ServiceFileError(`${path} is not the agent's own directory`);
  }
  if ((stats.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

function writeFileAt(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    // The process umask must not decide what a container may read.
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every entry below `directory`, relative and `/`-separated, with its lstat. */
function walk(directory: string): Map<string, Stats> {
  const entries = new Map<string, Stats>();
  const visit = (absolute: string) => {
    for (const name of readdirSync(absolute)) {
      const child = join(absolute, name);
      const stats = lstatSync(child);
      entries.set(relative(directory, child).split(sep).join("/"), stats);
      if (stats.isDirectory()) visit(child);
    }
  };
  visit(directory);
  return entries;
}

/** Whether the tree at `directory` holds exactly `tree`'s files and modes. */
function treeIntact(directory: string, tree: ServiceFileTree, uid: number): boolean {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o777) !== DIRECTORY_MODE) {
    return false;
  }
  const entries = walk(directory);
  const expected = new Map<string, ServiceFileTreeEntry | null>();
  for (const file of tree.files) {
    expected.set(file.path, file);
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      expected.set(parts.slice(0, index).join("/"), null);
  }
  if (entries.size !== expected.size) return false;
  for (const [path, stats] of entries) {
    if (!expected.has(path) || stats.uid !== uid) return false;
    const file = expected.get(path);
    if (file === null) {
      if (!stats.isDirectory() || (stats.mode & 0o777) !== DIRECTORY_MODE) return false;
    } else if (file) {
      if (!stats.isFile() || stats.nlink !== 1) return false;
      if ((stats.mode & 0o777) !== fileMode(file)) return false;
      if (!readFileSync(join(directory, path)).equals(file.bytes)) return false;
    }
  }
  return true;
}

const removeTree = (directory: string) => rmSync(directory, { recursive: true, force: true });

/**
 * Writes each tree the store doesn't have yet: into a temporary beside it,
 * then renamed into place. Its files are read-only; nothing writes a tree
 * once it is there. A tree already there is reused after checking that it
 * still holds exactly its files; one that doesn't fails the render, since a
 * container may mount it.
 */
export function writeServiceFileTrees(
  infraDir: string,
  trees: Iterable<ServiceFileTree>,
  uid: number = process.geteuid?.() ?? 0,
): void {
  const store = serviceFileStore(infraDir);
  ownDirectory(dirname(store), uid);
  ownDirectory(store, uid);
  for (const tree of trees) {
    const serviceDirectory = join(store, tree.serviceId);
    ownDirectory(serviceDirectory, uid);
    const target = join(serviceDirectory, tree.hash);
    if (existsSync(target) || lstatOrUndefined(target)) {
      if (!treeIntact(target, tree, uid)) {
        throw new ServiceFileError(
          `${relative(infraDir, target)} no longer holds the files it was written with. A container may still mount it: stop the services that use ${tree.serviceId}, remove the directory, and render again.`,
        );
      }
      continue;
    }
    const temporary = join(serviceDirectory, `.${tree.hash}.${randomBytes(6).toString("hex")}.tmp`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      const directories = new Set<string>();
      for (const file of tree.files) {
        const parts = file.path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
          const directory = join(temporary, ...parts.slice(0, index));
          if (!directories.has(directory)) {
            mkdirSync(directory, { mode: 0o700 });
            directories.add(directory);
          }
        }
        writeFileAt(join(temporary, ...parts), file.bytes, fileMode(file));
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        fsyncDirectory(directory);
        chmodSync(directory, DIRECTORY_MODE);
      }
      fsyncDirectory(temporary);
      chmodSync(temporary, DIRECTORY_MODE);
      renameSync(temporary, target);
    } catch (error) {
      try {
        removeTree(temporary);
      } catch {
        // The next render removes it.
      }
      throw error;
    }
    fsyncDirectory(serviceDirectory);
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

const generationFileSchema = z.strictObject({
  version: z.literal(1),
  trees: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), z.string().regex(TREE)),
});

/** The generation's record of the trees it mounts. */
export function serializeGenerationServiceFiles(
  trees: ReadonlyMap<string, ServiceFileTree>,
): string {
  return `${JSON.stringify({
    version: 1,
    trees: Object.fromEntries([...trees.values()].map((tree) => [tree.serviceId, tree.hash])),
  })}\n`;
}

/** The trees a generation directory records, or null when it records none (an earlier release's). */
export function readGenerationServiceFiles(generation: string): Map<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(join(generation, SERVICE_FILES_GENERATION_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return new Map(Object.entries(generationFileSchema.parse(JSON.parse(raw)).trees));
}

/**
 * Removes the trees no retained generation records and no container mounts,
 * and temporaries a stopped render left. With `mountedSources` unknown
 * (Docker can't tell), only the temporaries go: a container created from a
 * pruned generation still mounts its tree.
 */
export function collectServiceFileTrees(
  infraDir: string,
  recorded: ReadonlySet<string>,
  mountedSources: readonly string[] | undefined,
): string[] {
  const store = serviceFileStore(infraDir);
  const removed: string[] = [];
  let services: string[];
  try {
    services = readdirSync(store);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return removed;
    throw error;
  }
  const mounted = (path: string) =>
    mountedSources?.some((source) => source === path || source.startsWith(`${path}/`)) ?? true;
  for (const serviceId of services) {
    const serviceDirectory = join(store, serviceId);
    if (!lstatSync(serviceDirectory).isDirectory()) continue;
    for (const name of readdirSync(serviceDirectory)) {
      const path = join(serviceDirectory, name);
      const stale =
        TEMPORARY_TREE.test(name) ||
        (TREE.test(name) && !recorded.has(`${serviceId}/${name}`) && !mounted(path));
      if (!stale) continue;
      removeTree(path);
      removed.push(relative(infraDir, path));
    }
  }
  return removed;
}

/**
 * The host path of `path` of `serviceId` in the applied generation's tree,
 * for a build that mounts the same bytes the service does.
 */
export function appliedServiceFilePath(
  infraDir: string,
  generation: string | null,
  serviceId: string,
  path: string,
): string {
  const trees = generation ? readGenerationServiceFiles(generation) : null;
  const hash = trees?.get(serviceId);
  const absolute = hash
    ? resolve(serviceFileTreePath(infraDir, serviceId, hash), ...posix.normalize(path).split("/"))
    : null;
  if (!absolute || !existsSync(absolute)) {
    throw new ServiceFileError(
      `The applied configuration has no copy of services/${serviceId}/${path}. Render the stack first: pnpm openmapx compose render.`,
    );
  }
  return absolute;
}
