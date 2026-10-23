import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { Writable } from "node:stream";
import {
  BUILD_RECORD_DIR,
  type BuildRecord,
  type BuildRecordV2,
  type BundleManifest,
  buildArtifactSpec,
  DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
  safeArtifactPath,
  runtimeImageMismatches as sharedRuntimeImageMismatches,
  validateBuildBundle,
  writeBuildBundle,
} from "@openmapx/core/build-artifacts";
import { execa } from "execa";
import { promoteStagedBuildDirs } from "./build-staging";
import {
  assertCliExecutionAvailable,
  cliAcquisitionOptions,
  cliProcessOptions,
} from "./execution-deadline";
import { repoPaths, resolveInvocationPath } from "./paths";

export {
  BUILD_ARTIFACTS,
  BUILD_RECORD_DIR,
  BUNDLE_MANIFEST_PATH,
  type BuildArtifactSpec,
  type BuildRecord,
  type BuildRecordV2,
  type BundleFile,
  type BundleManifest,
  buildArtifactSpec,
  type ImageMismatch,
} from "@openmapx/core/build-artifacts";

function dataRootFor(rootDir?: string): string {
  return join(repoPaths(rootDir).infraDir, "data");
}

function buildRecordPath(dataRoot: string, serviceId: string): string {
  return join(dataRoot, BUILD_RECORD_DIR, `${serviceId}.json`);
}

export function writeBuildRecord(record: BuildRecord | BuildRecordV2, rootDir?: string): string {
  const path = buildRecordPath(dataRootFor(rootDir), record.service);
  mkdirSync(join(dataRootFor(rootDir), BUILD_RECORD_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return path;
}

export function readBuildRecord(
  serviceId: string,
  rootDir?: string,
): BuildRecord | BuildRecordV2 | undefined {
  const path = buildRecordPath(dataRootFor(rootDir), serviceId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as BuildRecord | BuildRecordV2;
}

export async function currentRevision(rootDir?: string): Promise<string | undefined> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    ...cliProcessOptions(),
    cwd: repoPaths(rootDir).root,
    reject: false,
  });
  const revision = result.exitCode === 0 ? String(result.stdout).trim() : "";
  return revision || undefined;
}

/** @deprecated Archive subprocesses are no longer used; kept for source compatibility. */
export type BundleCommandRunner = (
  args: string[],
  opts: { cwd?: string; stdin?: "inherit"; stdout?: "inherit" },
) => Promise<void>;
export interface ExportBuildBundleOptions {
  serviceId: string;
  bundle: string;
  rootDir?: string;
  tar?: BundleCommandRunner;
}
export async function exportBuildBundle(opts: ExportBuildBundleOptions): Promise<BundleManifest> {
  const dataRoot = dataRootFor(opts.rootDir);
  const record = readBuildRecord(opts.serviceId, opts.rootDir);
  if (!record)
    throw Error(
      `No build record for "${opts.serviceId}". Run openmapx services build ${opts.serviceId} first.`,
    );
  if (
    opts.serviceId === "motis" &&
    !record.runtimeImages.motis &&
    existsSync(join(dataRoot, "motis/live/data"))
  )
    throw Error(
      "MOTIS build ran without --import; rebuild with openmapx services build motis --import",
    );
  const target =
    opts.bundle === "-"
      ? new Writable({
          write(chunk, encoding, done) {
            process.stdout.write(chunk, encoding, done);
          },
        })
      : createWriteStream(resolveInvocationPath(opts.bundle), { flags: "wx", mode: 0o600 });
  target.on("error", () => undefined);
  try {
    return (
      await writeBuildBundle({
        dataRoot,
        serviceId: opts.serviceId,
        record,
        target,
        limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
        signal: cliAcquisitionOptions().signal ?? new AbortController().signal,
      })
    ).manifest;
  } catch (e) {
    if (target !== process.stdout) target.destroy();
    throw e;
  }
}
export async function runtimeImageMismatches(images: Record<string, string>, rootDir?: string) {
  return sharedRuntimeImageMismatches(images, repoPaths(rootDir).root);
}
export interface ImportBuildBundleOptions {
  bundle: string;
  rootDir?: string;
  tar?: BundleCommandRunner;
  runningServices: (ids: string[]) => Promise<string[]>;
}
export async function importBuildBundle(opts: ImportBuildBundleOptions): Promise<BundleManifest> {
  const dataRoot = dataRootFor(opts.rootDir);
  mkdirSync(dataRoot, { recursive: true });
  const stagingRoot = mkdtempSync(join(dataRoot, ".openmapx-import-"));
  try {
    const { manifest } = await validateBuildBundle({
      source:
        opts.bundle === "-" ? process.stdin : createReadStream(resolveInvocationPath(opts.bundle)),
      stagingRoot,
      limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: cliAcquisitionOptions().signal ?? new AbortController().signal,
    });
    const spec = buildArtifactSpec(manifest.service);
    const mismatches = await runtimeImageMismatches(manifest.runtimeImages, opts.rootDir);
    if (mismatches.length)
      throw Error(
        `Bundle was built for different runtime images (${mismatches.map((m) => `${m.service}: bundle ${m.bundle}, this host ${m.local}`).join("; ")}). Build and serve from the same OpenMapX revision.`,
      );
    if (manifest.schemaVersion === 2 && manifest.runtimeMaterialization)
      throw Error(
        "MOTIS portable bundle requires the target credential materialization workflow before readiness; rebuild locally until that workflow is available",
      );
    const running = await opts.runningServices(spec.consumers);
    if (running.length)
      throw Error(
        `Refusing to import: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running. Stop first with openmapx services stop ${running.join(" ")}.`,
      );
    const swaps = spec.dirs.map((dir) => {
      const live = join(dataRoot, dir);
      mkdirSync(dirname(live), { recursive: true });
      const liveDir =
        existsSync(live) && lstatSync(live).isSymbolicLink() ? realpathSync(live) : live;
      const physical = relative(
        realpathSync(dataRoot),
        existsSync(liveDir)
          ? realpathSync(liveDir)
          : join(realpathSync(dirname(liveDir)), dir.split("/").at(-1)!),
      );
      if (!safeArtifactPath(physical)) throw Error("Artifact target alias leaves data root");
      return { liveDir, nextDir: join(stagingRoot, dir) };
    });
    assertCliExecutionAvailable();
    promoteStagedBuildDirs(swaps);
    const { dirs: _dirs, directories: _directories, files: _files, ...record } = manifest;
    writeBuildRecord(record, opts.rootDir);
    return manifest;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
