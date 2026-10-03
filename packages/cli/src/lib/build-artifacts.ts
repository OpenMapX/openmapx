import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { promoteStagedBuildDirs } from "./build-staging";
import { repoPaths, resolveInvocationPath } from "./paths";

/**
 * What a `services build <id>` run leaves behind, and what has to travel when
 * the build ran on a different host than the one serving it.
 */
export interface BuildArtifactSpec {
  /** Output dirs relative to `infra/docker/data/`. */
  dirs: string[];
  /**
   * Build inputs staged into the output dir that the runtime never reads.
   * Matched against the path relative to the data root: a trailing `/` marks
   * a directory prefix, a leading `*` a filename suffix.
   */
  exclude: string[];
  /** Compose services that read the output; none may run during a swap. */
  consumers: string[];
}

export const BUILD_ARTIFACTS: Readonly<Record<string, BuildArtifactSpec>> = {
  tileserver: { dirs: ["tile-mbtiles"], exclude: [], consumers: ["tileserver"] },
  osrm: {
    dirs: ["osrm-graph"],
    exclude: ["osrm-graph/region.osm.pbf"],
    consumers: ["osrm"],
  },
  otp: { dirs: ["otp-graph"], exclude: ["*.pbf", "*.zip"], consumers: ["otp"] },
  pelias: {
    dirs: ["pelias"],
    exclude: ["pelias/openstreetmap/"],
    consumers: ["pelias", "pelias-pip", "pelias-placeholder", "elasticsearch"],
  },
  // `motis import` re-verifies every input named in config.yml on start, so
  // the timetables and PBF travel with the import output. `motis-staging` can
  // repoint or write the slot `motis/live` aliases, so it must be down too.
  motis: {
    dirs: ["motis/live", "motis-feed-proxy"],
    exclude: [],
    consumers: ["motis", "motis-staging"],
  },
};

export function buildArtifactSpec(serviceId: string): BuildArtifactSpec {
  const spec = Object.hasOwn(BUILD_ARTIFACTS, serviceId) ? BUILD_ARTIFACTS[serviceId] : undefined;
  if (!spec) throw new Error(`Service "${serviceId}" has no exportable build artifact`);
  return spec;
}

export const BUILD_RECORD_DIR = ".openmapx-builds";
const BUNDLE_MANIFEST_DIR = ".openmapx-bundle";
export const BUNDLE_MANIFEST_PATH = `${BUNDLE_MANIFEST_DIR}/manifest.json`;
const IMPORT_STAGING_DIR = ".openmapx-import";

export interface BuildRecord {
  schemaVersion: 1;
  service: string;
  region?: string;
  sourcePbf?: { name: string; sizeBytes: number };
  builtAt: string;
  /** Git commit of the OpenMapX checkout that ran the build, when known. */
  revision?: string;
  /**
   * Runtime images whose on-disk format the artifact is bound to, keyed by
   * compose service id. A serving host must run exactly these to load it.
   */
  runtimeImages: Record<string, string>;
  /** Helper images the build ran; informational. */
  toolImages: Record<string, string>;
}

export interface BundleFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface BundleManifest extends BuildRecord {
  dirs: string[];
  directories: string[];
  files: BundleFile[];
}

function dataRootFor(rootDir?: string): string {
  return join(repoPaths(rootDir).infraDir, "data");
}

function buildRecordPath(dataRoot: string, serviceId: string): string {
  return join(dataRoot, BUILD_RECORD_DIR, `${serviceId}.json`);
}

export function writeBuildRecord(record: BuildRecord, rootDir?: string): string {
  const path = buildRecordPath(dataRootFor(rootDir), record.service);
  mkdirSync(join(dataRootFor(rootDir), BUILD_RECORD_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return path;
}

export function readBuildRecord(serviceId: string, rootDir?: string): BuildRecord | undefined {
  const path = buildRecordPath(dataRootFor(rootDir), serviceId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as BuildRecord;
}

export async function currentRevision(rootDir?: string): Promise<string | undefined> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: repoPaths(rootDir).root,
    reject: false,
  });
  const revision = result.exitCode === 0 ? String(result.stdout).trim() : "";
  return revision || undefined;
}

function isExcluded(relPath: string, isDir: boolean, exclude: readonly string[]): boolean {
  const asDir = isDir ? `${relPath}/` : relPath;
  return exclude.some((pattern) => {
    if (pattern.startsWith("*")) return !isDir && relPath.endsWith(pattern.slice(1));
    if (pattern.endsWith("/")) return asDir.startsWith(pattern);
    return relPath === pattern;
  });
}

interface WalkedTree {
  directories: string[];
  files: string[];
}

/**
 * List every directory and regular file under `dirs` (relative to `base`),
 * applying the spec's excludes. Anything else (symlinks, sockets, devices) is
 * refused: a bundle carries plain files only, so it can't plant a link.
 */
function walkArtifact(
  base: string,
  dirs: readonly string[],
  exclude: readonly string[],
  opts: { allowAliasedRoot: boolean },
): WalkedTree {
  const tree: WalkedTree = { directories: [], files: [] };
  const visit = (rel: string, abs: string) => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in build artifact: ${rel}`);
    if (stat.isDirectory()) {
      if (isExcluded(rel, true, exclude)) return;
      tree.directories.push(rel);
      for (const name of readdirSync(abs).sort()) visit(`${rel}/${name}`, join(abs, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Refusing non-regular file in build artifact: ${rel}`);
    if (!isExcluded(rel, false, exclude)) tree.files.push(rel);
  };
  for (const dir of dirs) {
    const abs = join(base, dir);
    if (!existsSync(abs)) throw new Error(`Build artifact dir is missing: ${dir}`);
    // On the exporting host the artifact root may be an alias (the MOTIS slot
    // layout points `motis/live` at the active slot). An extracted bundle has
    // no such excuse: every segment down to the root must be a real dir.
    if (opts.allowAliasedRoot) {
      visit(dir, realpathSync(abs));
      continue;
    }
    let segmentPath = base;
    for (const segment of dir.split("/")) {
      segmentPath = join(segmentPath, segment);
      if (lstatSync(segmentPath).isSymbolicLink()) {
        throw new Error(`Refusing symlink in build artifact: ${dir}`);
      }
    }
    visit(dir, abs);
  }
  return tree;
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", rejectHash);
  });
}

function isSafeRelPath(rel: string): boolean {
  if (!rel || isAbsolute(rel) || rel.includes("\\")) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function bundlePath(bundle: string): string {
  return bundle === "-" ? bundle : resolveInvocationPath(bundle);
}

export type BundleCommandRunner = (
  args: string[],
  opts: { cwd?: string; stdin?: "inherit"; stdout?: "inherit" },
) => Promise<void>;

async function defaultTar(
  args: string[],
  opts: { cwd?: string; stdin?: "inherit"; stdout?: "inherit" },
): Promise<void> {
  await execa("tar", args, {
    cwd: opts.cwd,
    // Stops macOS tar from adding `._*` AppleDouble members.
    env: { COPYFILE_DISABLE: "1" },
    stdin: opts.stdin ?? "ignore",
    stdout: opts.stdout ?? "inherit",
    stderr: "inherit",
  });
}

export interface ExportBuildBundleOptions {
  serviceId: string;
  /** Destination file, or `-` for stdout. */
  bundle: string;
  rootDir?: string;
  tar?: BundleCommandRunner;
}

export async function exportBuildBundle(opts: ExportBuildBundleOptions): Promise<BundleManifest> {
  const spec = buildArtifactSpec(opts.serviceId);
  const dataRoot = dataRootFor(opts.rootDir);
  const record = readBuildRecord(opts.serviceId, opts.rootDir);
  if (!record) {
    throw new Error(
      `No build record for "${opts.serviceId}". Run \`openmapx services build ${opts.serviceId}\` on this host first.`,
    );
  }
  if (
    opts.serviceId === "motis" &&
    !record.runtimeImages.motis &&
    existsSync(join(dataRoot, "motis", "live", "data"))
  ) {
    throw new Error(
      "motis/live holds import output, but the last build ran without --import, so it isn't tied to a MOTIS image. Rebuild with `openmapx services build motis --import` before exporting.",
    );
  }
  const tree = walkArtifact(dataRoot, spec.dirs, spec.exclude, { allowAliasedRoot: true });
  const files: BundleFile[] = [];
  for (const rel of tree.files) {
    const abs = join(dataRoot, rel);
    files.push({ path: rel, sizeBytes: lstatSync(abs).size, sha256: await sha256OfFile(abs) });
  }
  const manifest: BundleManifest = {
    ...record,
    dirs: spec.dirs,
    directories: tree.directories,
    files,
  };

  // bsdtar stops reading options at the first operand, so everything is
  // archived from the data root in one `-C`, manifest included.
  const manifestDir = join(dataRoot, BUNDLE_MANIFEST_DIR);
  const scratch = mkdtempSync(join(tmpdir(), "openmapx-export-"));
  try {
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(dataRoot, BUNDLE_MANIFEST_PATH), `${JSON.stringify(manifest)}\n`);
    const listPath = join(scratch, "members.txt");
    // Manifest first so an importer meets it before the payload; members are
    // listed explicitly (no recursion) so the archive matches it exactly.
    const members = [BUNDLE_MANIFEST_PATH, ...tree.directories, ...tree.files];
    writeFileSync(listPath, `${members.join("\n")}\n`);
    const tar = opts.tar ?? defaultTar;
    // `-h` stores an aliased artifact root as the directory it points at.
    await tar(
      [
        "-chf",
        bundlePath(opts.bundle),
        "--no-recursion",
        "--no-xattrs",
        "-C",
        dataRoot,
        "-T",
        listPath,
      ],
      { stdout: opts.bundle === "-" ? "inherit" : undefined },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(manifestDir, { recursive: true, force: true });
  }
  return manifest;
}

function parseBundleManifest(text: string): BundleManifest {
  const parsed = JSON.parse(text) as Partial<BundleManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.service !== "string" ||
    !Array.isArray(parsed.dirs) ||
    !Array.isArray(parsed.directories) ||
    !Array.isArray(parsed.files) ||
    typeof parsed.runtimeImages !== "object" ||
    parsed.runtimeImages === null
  ) {
    throw new Error("Bundle manifest is malformed");
  }
  return parsed as BundleManifest;
}

/**
 * The extracted tree must be exactly what the manifest lists: same dirs, same
 * files, same bytes. Anything extra, missing, or altered fails the import.
 */
async function verifyExtractedBundle(
  stagingRoot: string,
  manifest: BundleManifest,
  spec: BuildArtifactSpec,
): Promise<void> {
  if (JSON.stringify([...manifest.dirs].sort()) !== JSON.stringify([...spec.dirs].sort())) {
    throw new Error(
      `Bundle dirs [${manifest.dirs.join(", ")}] do not match "${manifest.service}" artifact dirs [${spec.dirs.join(", ")}]`,
    );
  }
  const inArtifact = (rel: string) =>
    isSafeRelPath(rel) && spec.dirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
  for (const rel of [...manifest.directories, ...manifest.files.map((f) => f.path)]) {
    if (!inArtifact(rel)) throw new Error(`Bundle lists a path outside its artifact: ${rel}`);
  }

  const tree = walkArtifact(stagingRoot, spec.dirs, [], { allowAliasedRoot: false });
  const extractedDirs = new Set(tree.directories);
  const missingDir = manifest.directories.find((rel) => !extractedDirs.has(rel));
  if (missingDir) throw new Error(`Bundle is missing ${missingDir}/`);
  const expectedDirs = new Set(manifest.directories);
  const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]));
  const unexpected = [
    ...tree.directories.filter((rel) => !expectedDirs.has(rel)),
    ...tree.files.filter((rel) => !expectedFiles.has(rel)),
  ];
  if (unexpected.length > 0) {
    throw new Error(`Bundle contains entries its manifest does not list: ${unexpected[0]}`);
  }
  const extracted = new Set(tree.files);
  for (const file of manifest.files) {
    if (!extracted.has(file.path)) throw new Error(`Bundle is missing ${file.path}`);
    const abs = join(stagingRoot, file.path);
    if (lstatSync(abs).size !== file.sizeBytes || (await sha256OfFile(abs)) !== file.sha256) {
      throw new Error(`Bundle file failed verification: ${file.path}`);
    }
  }
}

export interface ImageMismatch {
  service: string;
  bundle: string;
  local: string;
}

export async function runtimeImageMismatches(
  runtimeImages: Record<string, string>,
  rootDir?: string,
): Promise<ImageMismatch[]> {
  const registry = new coreServices.ServiceRegistry({ rootDir: repoPaths(rootDir).root });
  await registry.load();
  const mismatches: ImageMismatch[] = [];
  for (const [service, bundle] of Object.entries(runtimeImages)) {
    const loaded = registry.get(service);
    const local = loaded
      ? coreServices.serviceContainerImageReference(loaded.manifest.container)
      : "(not installed)";
    if (local !== bundle) mismatches.push({ service, bundle, local });
  }
  return mismatches;
}

export interface ImportBuildBundleOptions {
  /** Source file, or `-` for stdin. */
  bundle: string;
  rootDir?: string;
  tar?: BundleCommandRunner;
  /** Compose services currently running; injected by the CLI. */
  runningServices: (ids: string[]) => Promise<string[]>;
}

export async function importBuildBundle(opts: ImportBuildBundleOptions): Promise<BundleManifest> {
  const dataRoot = dataRootFor(opts.rootDir);
  const stagingRoot = join(dataRoot, IMPORT_STAGING_DIR);
  // Extract inside the data root so the final swap is a same-filesystem rename.
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  try {
    const tar = opts.tar ?? defaultTar;
    await tar(["-xf", bundlePath(opts.bundle), "-C", stagingRoot, "--no-same-owner"], {
      stdin: opts.bundle === "-" ? "inherit" : undefined,
    });
    const manifestPath = join(stagingRoot, BUNDLE_MANIFEST_PATH);
    if (!existsSync(manifestPath)) throw new Error(`Bundle has no ${BUNDLE_MANIFEST_PATH}`);
    const manifest = parseBundleManifest(readFileSync(manifestPath, "utf-8"));
    const spec = buildArtifactSpec(manifest.service);
    await verifyExtractedBundle(stagingRoot, manifest, spec);

    const mismatches = await runtimeImageMismatches(manifest.runtimeImages, opts.rootDir);
    if (mismatches.length > 0) {
      const detail = mismatches
        .map((m) => `${m.service}: bundle ${m.bundle}, this host ${m.local}`)
        .join("; ");
      throw new Error(
        `Bundle was built for different runtime images (${detail}). Build and serve from the same OpenMapX revision.`,
      );
    }

    const running = await opts.runningServices(spec.consumers);
    if (running.length > 0) {
      throw new Error(
        `Refusing to import: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running. ` +
          `Stop first with \`openmapx services stop ${running.join(" ")}\`.`,
      );
    }

    const swaps = spec.dirs.map((dir) => {
      const live = join(dataRoot, dir);
      mkdirSync(dirname(live), { recursive: true });
      // Swap the aliased directory, not the alias: the MOTIS slot layout keeps
      // `motis/live` pointing at the active slot and won't adopt a real dir.
      const liveDir =
        existsSync(live) && lstatSync(live).isSymbolicLink() ? realpathSync(live) : live;
      return { liveDir, nextDir: join(stagingRoot, dir) };
    });
    promoteStagedBuildDirs(swaps);
    const { dirs: _dirs, directories: _directories, files: _files, ...record } = manifest;
    writeBuildRecord(record, opts.rootDir);
    return manifest;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
