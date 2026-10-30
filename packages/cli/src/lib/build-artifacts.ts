import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import * as control from "@openmapx/core/build-artifacts";
import {
  BUILD_RECORD_DIR,
  type BuildRecord,
  type BuildRecordV2,
  type BundleManifest,
  buildArtifactSpec,
  buildRecordSchema,
  DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
  runtimeImageMismatches as sharedRuntimeImageMismatches,
  validateBuildBundle,
  withDataDirectory,
  writeBuildBundle,
} from "@openmapx/core/build-artifacts";
import {
  inspectMotisPortableDestination,
  materializeMotisPortableDestination,
} from "@openmapx/core/build-artifacts/motis-destination";
import {
  artifactPublicationFingerprint,
  publishValidatedBuild,
} from "@openmapx/core/build-artifacts/publication";
import * as dm from "@openmapx/core/data-manager-sdk";
import { artifactExportOperationSchema } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { execa } from "execa";
import { runsFromAgentBundle } from "./agent-bundle";
import {
  type CliArtifactOwner,
  closeCliArtifactOwner,
  openCliArtifactOwner,
  settleCliArtifactOwner,
  settleCliReadOnlyExport,
} from "./artifact-ownership";
import { dataManagerUrl } from "./data-manager-url";
import { dockerCompose, runningComposeServicesStrict } from "./docker";
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
  const checked = buildRecordSchema.parse(record);
  mkdirSync(dataRootFor(rootDir), { recursive: true });
  withDataDirectory(dataRootFor(rootDir), "", (root) => {
    const directory = root.directory(BUILD_RECORD_DIR, true);
    try {
      directory.write(`${checked.service}.json`, `${JSON.stringify(checked)}\n`);
    } finally {
      directory.close();
    }
  });
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

/**
 * Where a build came from: the selected release, and the commit of the
 * checkout whose CLI ran it. The operations agent's bundled CLI is not the
 * checkout's code, so it records the release alone and runs no git in the
 * checkout. Both are informational; one that cannot be read is left out.
 */
export async function buildProvenance(
  rootDir?: string,
  options: { bundled?: boolean } = {},
): Promise<Pick<BuildRecord, "revision" | "release">> {
  const paths = repoPaths(rootDir);
  let release: string | undefined;
  try {
    const overlay = services.readReleaseOverlay(paths.infraDir);
    release =
      (overlay === null ? null : services.parseReleaseComposeSelection(overlay).release) ??
      undefined;
  } catch {
    release = undefined;
  }
  let revision: string | undefined;
  if (!(options.bundled ?? runsFromAgentBundle())) {
    const result = await execa("git", ["rev-parse", "HEAD"], {
      ...cliProcessOptions(),
      cwd: paths.root,
      reject: false,
    });
    revision = (result.exitCode === 0 ? String(result.stdout).trim() : "") || undefined;
  }
  return { ...(revision ? { revision } : {}), ...(release ? { release } : {}) };
}

export async function currentRevision(rootDir?: string): Promise<string | undefined> {
  return (await buildProvenance(rootDir)).revision;
}

/** @deprecated Archive subprocesses are no longer used; kept for source compatibility. */
export type BundleCommandRunner = (
  args: string[],
  opts: { cwd?: string; stdin?: "inherit"; stdout?: "inherit" },
) => Promise<void>;
export interface ExportBuildBundleOptions {
  runningServices?: (ids: string[]) => Promise<string[]>;
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
  const runningServices =
    opts.runningServices ?? ((ids: string[]) => runningComposeServicesStrict(ids, opts.rootDir));
  const compatible = async () => {
    if ((await runningServices(buildArtifactSpec(opts.serviceId).consumers)).length)
      throw Error("Prepared data consumers must be stopped before exporting");
    if ((await runtimeImageMismatches(record.runtimeImages, opts.rootDir)).length)
      throw Error("Prepared data runtime images differ from this host");
  };
  await compatible();
  let expectedArtifactFingerprint: string;
  if (record.schemaVersion === 2 && opts.serviceId !== "motis")
    expectedArtifactFingerprint = record.artifactFingerprint;
  else {
    // Legacy records have no retained file digest. An inert first pass derives
    // the exact immutable request; the leased output pass must still match it.
    const inspected = await writeBuildBundle({
      dataRoot,
      serviceId: opts.serviceId,
      record,
      target: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: cliAcquisitionOptions().signal ?? new AbortController().signal,
    });
    expectedArtifactFingerprint = inspected.artifactFingerprint;
  }
  const owner = await openCliArtifactOwner(
    artifactExportOperationSchema.parse({
      kind: "artifactTransfer.export",
      serviceId: opts.serviceId,
      ownerId: "host-cli",
      expectedArtifactFingerprint,
    }),
    opts.rootDir,
  );
  let target: Writable | undefined;
  try {
    await compatible();
    target =
      opts.bundle === "-"
        ? new Writable({
            write(chunk, encoding, done) {
              process.stdout.write(chunk, encoding, done);
            },
          })
        : createWriteStream(resolveInvocationPath(opts.bundle), { flags: "wx", mode: 0o600 });
    target.on("error", () => undefined);
    const written = await services.withConfigurationGenerationWriter(
      owner.paths.infraDir,
      async () => {
        const revision = services.currentConfigurationGeneration(owner.paths.infraDir);
        const result = await writeBuildBundle({
          dataRoot,
          serviceId: opts.serviceId,
          record,
          target: target!,
          limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
          signal: owner.signal,
        });
        await compatible();
        if (
          result.artifactFingerprint !== expectedArtifactFingerprint ||
          revision !== services.currentConfigurationGeneration(owner.paths.infraDir)
        )
          throw Error("Prepared export source changed");
        return result;
      },
      owner.signal,
    );
    await settleCliReadOnlyExport(owner);
    return written.manifest;
  } catch (error) {
    target?.destroy();
    throw error;
  } finally {
    closeCliArtifactOwner(owner);
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
export class ArtifactImportCommittedError extends Error {
  constructor() {
    super(
      "Artifacts were committed, but hardlinks were not applied. Keep consumers stopped; reconcile the current generation before Start.",
    );
  }
}
export async function importBuildBundle(opts: ImportBuildBundleOptions): Promise<BundleManifest> {
  const paths = repoPaths(opts.rootDir),
    dataRoot = dataRootFor(opts.rootDir),
    stageId = randomUUID();
  mkdirSync(dataRoot, { recursive: true });
  const stagingRoot = join(dataRoot, `.openmapx-import-${stageId}`);
  mkdirSync(stagingRoot, { mode: 0o700 });
  let owner: CliArtifactOwner | undefined,
    discard = true,
    settled = false;
  try {
    const bundle = await validateBuildBundle({
      source:
        opts.bundle === "-" ? process.stdin : createReadStream(resolveInvocationPath(opts.bundle)),
      stagingRoot,
      limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: cliAcquisitionOptions().signal ?? new AbortController().signal,
    });
    const { manifest } = bundle,
      spec = buildArtifactSpec(manifest.service);
    const compatible = async () => {
      const mismatches = await runtimeImageMismatches(manifest.runtimeImages, opts.rootDir);
      if (mismatches.length)
        throw Error(
          `Bundle was built for different runtime images (${mismatches.map((m) => `${m.service}: bundle ${m.bundle}, this host ${m.local}`).join("; ")}). Build and serve from the same OpenMapX revision.`,
        );
      const running = await opts.runningServices(spec.consumers);
      if (running.length)
        throw Error(
          `Refusing to import: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running. Stop first with openmapx services stop ${running.join(" ")}.`,
        );
    };
    await compatible();
    const motisDestination = async (signal?: AbortSignal) => {
      const revision = services.currentConfigurationGeneration(paths.infraDir);
      if (!revision) throw Error("MOTIS import requires a generated destination configuration");
      const config = await dockerCompose(["config", "--format", "json"], opts.rootDir);
      if (config.exitCode !== 0) throw Error("Destination Compose configuration is unavailable");
      const parsed: unknown = JSON.parse(config.stdout);
      if (!parsed || typeof parsed !== "object")
        throw Error("Invalid destination Compose configuration");
      const environment = (parsed as { services?: Record<string, { environment?: unknown }> })
        .services?.["data-manager"]?.environment;
      if (
        environment !== undefined &&
        (!environment || typeof environment !== "object" || Array.isArray(environment))
      )
        throw Error("Invalid data manager environment");
      const env = Object.fromEntries(
        Object.entries(environment ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      return {
        rootDir: paths.root,
        infraDir: paths.infraDir,
        stagingDir: join(stagingRoot, "motis/live"),
        configurationRevisionId: revision,
        dataManagerEnvironment: env,
        signal,
      };
    };
    const motisPreview =
      manifest.service === "motis"
        ? await inspectMotisPortableDestination(
            await motisDestination(cliAcquisitionOptions().signal),
          )
        : null;
    const expectedFingerprint = await artifactPublicationFingerprint(dataRoot, manifest.service),
      expectedCurrentRevisionId = services.currentConfigurationGeneration(paths.infraDir);
    owner = await openCliArtifactOwner(
      {
        kind: "artifactTransfer.import",
        stageId,
        ownerId: "host-cli",
        expectedSha256: bundle.archiveSha256,
        previewFingerprint: control.controlDigest({
          expectedFingerprint,
          expectedCurrentRevisionId,
          archive: bundle.archiveSha256,
        }),
        expectedCurrentRevisionId,
      },
      opts.rootDir,
    );
    const transport = dm.createDataManagerTransport({
      baseUrl: dataManagerUrl(),
      authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
      requestTimeoutMs: 15000,
      maxJsonBytes: 65536,
    });
    const requireCoordinator = async () => {
      if (
        owner?.hardlinks?.plan.plan.length &&
        !dm.unwrapDataManagerResponse(await dm.getStatus({ transport, signal: owner.signal })).ok
      )
        throw Error("Data manager must already be running to apply imported hardlinks");
    };
    await requireCoordinator();
    assertCliExecutionAvailable();
    discard = false;
    const materializeMotis = motisPreview
      ? async () => {
          const capacity = statfsSync(dataRoot, { bigint: true });
          if (
            capacity.bavail * capacity.bsize < BigInt(64 * 1024 * 1024 + 1024 ** 3) ||
            capacity.ffree < 64n
          )
            throw Error("Insufficient destination capacity for MOTIS materialization");
          return (
            await materializeMotisPortableDestination({
              ...(await motisDestination(owner!.signal)),
              expectedFingerprint: motisPreview.fingerprint,
              archiveFingerprint: bundle.artifactFingerprint,
            })
          ).materialization;
        }
      : undefined;
    const result = await publishValidatedBuild({
      bundle,
      materializeMotis,
      stagingRoot,
      stageId,
      dataRoot,
      authority: owner!.authority,
      lease: owner!.lease,
      expectedFingerprint,
      signal: owner!.signal,
      beforePublication: async () => {
        await compatible();
        await requireCoordinator();
        if (
          motisPreview &&
          (await inspectMotisPortableDestination(await motisDestination(owner!.signal)))
            .fingerprint !== motisPreview.fingerprint
        )
          throw Error("MOTIS destination changed before publication");
        return () => {};
      },
    });
    if (result.outcome !== "committed") {
      await settleCliArtifactOwner(owner, result);
      settled = true;
      discard = !result.cleanupFailed;
      throw Error(
        `Prepared artifacts were not committed (${result.reason}); existing data was preserved.`,
      );
    }
    let followUp: "complete" | "failed" = "complete";
    if (owner.hardlinks) {
      try {
        await services.withConfigurationGenerationWriter(
          paths.infraDir,
          () =>
            control.executeOwnedGenerationHardlinks({
              authority: owner!.authority,
              lease: owner!.lease,
              infraDir: paths.infraDir,
              transport,
              signal: owner!.signal,
            }),
          owner.signal,
        );
      } catch (error) {
        if (
          owner.hardlinks.reservation &&
          control.lookupControlChildPhaseBinding(owner.authority, owner.hardlinks.reservation)
        )
          throw Error(
            "Artifacts committed; original hardlink execution is unresolved. Retain the import workspace and reconcile its original owner.",
            { cause: error },
          );
        followUp = "failed";
      }
    }
    await settleCliArtifactOwner(owner, { ...result, followUp });
    settled = true;
    discard = !result.cleanupFailed;
    if (followUp === "failed") throw new ArtifactImportCommittedError();
    return manifest;
  } catch (error) {
    if (owner && discard && !settled) {
      await settleCliArtifactOwner(owner, {
        outcome: "not_committed",
        reason: "failed",
        cleanupFailed: false,
      });
      settled = true;
    }
    throw error;
  } finally {
    if (owner) closeCliArtifactOwner(owner);
    if (discard) rmSync(stagingRoot, { recursive: true, force: true });
  }
}
