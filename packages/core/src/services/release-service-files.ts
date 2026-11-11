import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import z from "zod/v4";
import { readRegularFileBytes } from "./built-in-service-source";
import { embeddedBuiltInServiceManifests } from "./embedded-built-in-services";
import { embeddedBuiltInServiceFiles } from "./embedded-service-files";
import { RELEASE_SELECTOR_ENV } from "./release-manifest";
import type { LoadedService, ServiceManifest } from "./types";

/**
 * The files built-in services mount from their own directories (and from
 * another built-in's, through `@service:`), which the release supplies.
 *
 * The ops-agent's runtime bundle embeds them, so the agent and its fixed CLI
 * render the bytes of their image. Run from source (tests, the host CLI),
 * they are the checkout's.
 */

/** Traefik's files, which its mounts no longer name (they come through the agent's state). */
export const TRAEFIK_RELEASE_PATHS = Object.freeze(["config/traefik.yml", "config/dynamic"]);
const MAX_SERVICE_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SERVICE_PREFIX = "@service:";

/** A path a built-in names in its service directory: a file or a directory. */
export interface ServiceFileReference {
  readonly serviceId: string;
  readonly path: string;
  /** Whether a mount names it; Traefik's files are read by render instead. */
  readonly mounted: boolean;
  /** The `@infra:data/...` copy a container rewrites, when it has one. */
  readonly writableCopy?: string;
}

/**
 * Every path built-in manifests name in a service directory: relative bind
 * sources, `@service:<id>:<path>` ones (which belong to `<id>`), and Traefik's
 * configuration. Sorted and without duplicates.
 */
export function serviceFileReferences(
  manifests: readonly ServiceManifest[],
): ServiceFileReference[] {
  const references = new Map<string, ServiceFileReference>();
  const add = (reference: ServiceFileReference) => {
    const key = `${reference.serviceId}/${reference.path}`;
    const existing = references.get(key);
    references.set(key, {
      ...reference,
      mounted: reference.mounted || existing?.mounted === true,
      ...(reference.writableCopy || existing?.writableCopy
        ? { writableCopy: reference.writableCopy ?? existing?.writableCopy }
        : {}),
    });
  };
  for (const manifest of manifests) {
    for (const mount of manifest.bindMounts ?? []) {
      const source = mount.source;
      if (source.startsWith(SERVICE_PREFIX)) {
        const rest = source.slice(SERVICE_PREFIX.length);
        const colon = rest.indexOf(":");
        if (colon > 0) {
          add({
            serviceId: rest.slice(0, colon),
            path: posix.normalize(rest.slice(colon + 1)),
            mounted: true,
          });
        }
        continue;
      }
      if (source.startsWith("@") || source.startsWith("$") || source.startsWith("/")) continue;
      add({
        serviceId: manifest.id,
        path: posix.normalize(source),
        mounted: true,
        ...(mount.writableCopy ? { writableCopy: mount.writableCopy } : {}),
      });
    }
    if (manifest.id === "traefik") {
      for (const path of TRAEFIK_RELEASE_PATHS) add({ serviceId: "traefik", path, mounted: false });
    }
  }
  return [...references.values()].sort((a, b) =>
    `${a.serviceId}/${a.path}`.localeCompare(`${b.serviceId}/${b.path}`),
  );
}

export interface ReleaseServiceFile {
  readonly serviceId: string;
  readonly path: string;
  readonly executable: boolean;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface ReleaseServiceFiles {
  /**
   * The release's own files (its bundle or its image), or the checkout's:
   * read from it, or, under `OPENMAPX_RELEASE=local`, from the agent's
   * bundle, which its image took from the checkout when it was built.
   */
  readonly origin: "release" | "checkout";
  /** By `<serviceId>/<path>`. */
  readonly files: ReadonlyMap<string, ReleaseServiceFile>;
  /** The sha256 of each built-in's `service.json`; empty for the checkout. */
  readonly manifests: ReadonlyMap<string, string>;
  /** Referenced paths the checkout lacks; always empty for a release. */
  readonly missing: readonly string[];
  /**
   * The checkout's files as the agent's image holds them, under
   * `OPENMAPX_RELEASE=local`: an edit made in `services/` since the image was
   * built is not among them.
   */
  readonly builtIntoImage?: true;
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The files of `set` at `path` of `serviceId`: the file itself, or those below a directory. */
export function releaseFilesAt(
  set: ReleaseServiceFiles,
  serviceId: string,
  path: string,
): ReleaseServiceFile[] {
  const exact = set.files.get(`${serviceId}/${path}`);
  if (exact) return [exact];
  const prefix = `${serviceId}/${path}/`;
  return [...set.files.entries()].filter(([key]) => key.startsWith(prefix)).map(([, file]) => file);
}

/** The release's files embedded in this runtime bundle, or `null` when running from source. */
export function readEmbeddedReleaseServiceFiles(): ReleaseServiceFiles | null {
  const embedded = embeddedBuiltInServiceFiles();
  const manifestSource = embeddedBuiltInServiceManifests();
  if (!embedded || !manifestSource) return null;
  const files = new Map<string, ReleaseServiceFile>();
  for (const file of embedded.files) {
    const bytes = readFileSync(fileURLToPath(file.url));
    files.set(`${file.serviceId}/${file.path}`, {
      serviceId: file.serviceId,
      path: file.path,
      executable: file.executable,
      bytes,
      sha256: sha256(bytes),
    });
  }
  const manifests = new Map<string, string>();
  for (const id of manifestSource.ids) {
    manifests.set(
      id,
      sha256(readRegularFileBytes(manifestSource.manifestPath(id), MAX_MANIFEST_BYTES)),
    );
  }
  return { origin: "release", files, manifests, missing: [] };
}

/** Thrown when a file render must read can't be used; its message names the file, never its contents. */
export class ServiceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceFileError";
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

/**
 * A regular file's bytes, opened without following a link, or why it may not
 * be used: render reads only the deployment user's own files with one link.
 */
export function readOwnedRegularFile(
  path: string,
  uid: number,
): { bytes: Buffer; mode: number } | { reason: string } {
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
    if (stats.size > MAX_SERVICE_FILE_BYTES) return { reason: "it is larger than 1 MiB" };
    return { bytes: readFileSync(fd), mode: stats.mode };
  } finally {
    closeSync(fd);
  }
}

/** Why a directory render would read may not be used, or null when it may. */
export function ownedDirectoryProblem(stats: Stats | undefined, uid: number): string | null {
  if (!stats) return "it is missing";
  if (stats.isSymbolicLink()) return "it is a symbolic link";
  if (!stats.isDirectory()) return "it is not a directory";
  if (stats.uid !== uid) return `it belongs to uid ${stats.uid}, not ${uid}`;
  return null;
}

/**
 * The files the checkout's built-in services name, read as the release's
 * (running from source). A directory is read whole, skipping dot entries. A
 * file or directory that is there but may not be used fails; one that is
 * missing is listed.
 */
export function readCheckoutServiceFiles(
  services: readonly LoadedService[],
  uid: number,
): ReleaseServiceFiles {
  const builtIns = services.filter((service) => service.isBuiltIn);
  const directories = new Map(builtIns.map((service) => [service.manifest.id, service.directory]));
  const files = new Map<string, ReleaseServiceFile>();
  const missing: string[] = [];
  const fail = (serviceId: string, path: string, reason: string): never => {
    throw new ServiceFileError(`services/${serviceId}/${path} can't be used: ${reason}`);
  };
  const visit = (serviceId: string, directory: string, path: string, top: boolean) => {
    const absolute = posix.join(directory, path);
    const stats = lstatOrUndefined(absolute);
    if (!stats) {
      if (top) missing.push(`${serviceId}/${path}`);
      return;
    }
    if (stats.isDirectory()) {
      const problem = ownedDirectoryProblem(stats, uid);
      if (problem) fail(serviceId, path, problem);
      for (const name of readdirSync(absolute).sort()) {
        if (name.startsWith(".")) continue;
        visit(serviceId, directory, `${path}/${name}`, false);
      }
      return;
    }
    const read = readOwnedRegularFile(absolute, uid);
    if ("reason" in read) fail(serviceId, path, read.reason);
    else {
      files.set(`${serviceId}/${path}`, {
        serviceId,
        path,
        executable: (read.mode & 0o111) !== 0,
        bytes: read.bytes,
        sha256: sha256(read.bytes),
      });
    }
  };
  for (const reference of serviceFileReferences(builtIns.map((service) => service.manifest))) {
    const directory = directories.get(reference.serviceId);
    if (!directory) continue;
    visit(reference.serviceId, directory, reference.path, true);
  }
  return { origin: "checkout", files, manifests: new Map(), missing };
}

/**
 * The release's files this process renders, when it renders a release's:
 * those its bundle embeds, unless `OPENMAPX_RELEASE=local` makes them the
 * checkout's (see {@link releaseServiceFiles}).
 */
export function renderedEmbeddedReleaseServiceFiles(): ReleaseServiceFiles | null {
  if (process.env[RELEASE_SELECTOR_ENV] === "local") return null;
  return readEmbeddedReleaseServiceFiles();
}

/**
 * The service files this process renders: those its bundle embeds when
 * bundled (the operations agent and its fixed CLI), otherwise the checkout's.
 * Under `OPENMAPX_RELEASE=local` the agent's image was built from the
 * checkout, so its bundle holds the checkout's files as of that build, and
 * they count as the checkout's.
 */
export function releaseServiceFiles(
  services: readonly LoadedService[],
  uid: number = process.geteuid?.() ?? 0,
): ReleaseServiceFiles {
  const embedded = readEmbeddedReleaseServiceFiles();
  if (!embedded) return readCheckoutServiceFiles(services, uid);
  if (process.env[RELEASE_SELECTOR_ENV] !== "local") return embedded;
  return {
    origin: "checkout",
    files: embedded.files,
    manifests: new Map(),
    missing: [],
    builtIntoImage: true,
  };
}

/** The `compose release-files` index version this CLI reads and writes. */
const INDEX_VERSION = 2;

const indexSchema = z.strictObject({
  version: z.literal(INDEX_VERSION),
  manifests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  files: z
    .array(
      z.strictObject({
        serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        path: z
          .string()
          .min(1)
          .max(512)
          .refine(
            (path) =>
              !path.startsWith("/") &&
              posix.normalize(path) === path &&
              !path.split("/").includes(".."),
          ),
        executable: z.boolean(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.string().max(2 * MAX_SERVICE_FILE_BYTES),
      }),
    )
    .max(1024),
});

/** The index `openmapx compose release-files` prints from a release's bundle. */
export function serializeReleaseServiceFiles(set: ReleaseServiceFiles): string {
  return `${JSON.stringify({
    version: INDEX_VERSION,
    manifests: Object.fromEntries([...set.manifests].sort(([a], [b]) => a.localeCompare(b))),
    files: [...set.files.values()].map((file) => ({
      serviceId: file.serviceId,
      path: file.path,
      executable: file.executable,
      sha256: file.sha256,
      bytes: file.bytes.toString("base64"),
    })),
  })}\n`;
}

/**
 * Parses a release's index, checking each file's bytes against its hash. A
 * version 1 index comes from an image built before this checkout, whose CLI
 * reads only the current version.
 */
export function parseReleaseServiceFiles(raw: string): ReleaseServiceFiles {
  const json: unknown = JSON.parse(raw);
  if (z.object({ version: z.literal(1) }).safeParse(json).success) {
    throw new Error(
      `its service file index is version 1, which this checkout no longer reads (it reads version ${INDEX_VERSION}): the selected release's image predates this checkout. Rebuild the image from this checkout, or select a newer release`,
    );
  }
  const parsed = indexSchema.parse(json);
  const files = new Map<string, ReleaseServiceFile>();
  for (const file of parsed.files) {
    const bytes = Buffer.from(file.bytes, "base64");
    if (sha256(bytes) !== file.sha256)
      throw new Error(`${file.serviceId}/${file.path} does not match its hash`);
    files.set(`${file.serviceId}/${file.path}`, { ...file, bytes });
  }
  return {
    origin: "release",
    files,
    manifests: new Map(Object.entries(parsed.manifests)),
    missing: [],
  };
}
