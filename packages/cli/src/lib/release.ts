import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { cliProcessOptions } from "./execution-deadline";
import { repoPaths } from "./paths";

const {
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_SELECTOR_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  parseReleaseManifest,
  writeReleaseComposeArtifacts,
} = coreServices;

export type ReleaseManifest = coreServices.ReleaseManifest;

/**
 * Where the release selection lives: the agent's release state under
 * `infra/docker`, shared with the host CLI, which runs as the agent's user.
 * `uid` is the owner that state must have; tests inject another.
 */
export interface ReleaseStateLocation {
  infraDir?: string;
  uid?: number;
}

function releaseState(opts: ReleaseStateLocation) {
  return coreServices.releaseStatePaths(opts.infraDir ?? repoPaths().infraDir);
}

function appliedReleaseChannel(
  infraDir = repoPaths().infraDir,
): ReturnType<typeof coreServices.releaseChannel> {
  const selection = coreServices.readAppliedReleaseSelection(infraDir);
  return selection.kind === "local"
    ? { kind: "disabled" }
    : {
        kind: "enabled",
        selection,
        manifestImage: selection.manifestImage,
        imagePrefix: selection.imagePrefix,
      };
}

export type ReleaseDockerRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

async function defaultDocker(args: string[]) {
  const result = await execa("docker", args, { ...cliProcessOptions(), reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

function expectOk(result: { exitCode: number; stderr: string }, what: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

const coordinatorGuidance =
  "Data Manager already uses the selected release. Use System → Updates for a coordinated update " +
  "(/admin/system/updates; older installations: /admin/system). " +
  "For recovery, reselect the exact immutable pin used by the existing Data Manager.";

function assertNoReleaseTransaction(store: string): void {
  try {
    lstatSync(join(store, "transaction.json"));
    throw Error("Release transaction is active; finish or recover the update first");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A failed Docker read is never proof that an existing coordinator is absent. */
async function inspectCoordinator(docker: ReleaseDockerRunner) {
  const listing = await docker([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${coreServices.STACK_PROJECT}`,
    "--filter",
    "label=com.docker.compose.service=data-manager",
    "--format",
    "{{.ID}}",
  ]);
  expectOk(listing, "Docker coordinator observation");
  if (listing.stdout.length > 1024) throw Error("Coordinator observation exceeds its bound");
  const ids = listing.stdout.trim() ? listing.stdout.trim().split(/\r?\n/) : [];
  if (!ids.length) return null;
  const id = ids[0];
  if (ids.length !== 1 || !id || !/^[a-f0-9]{64}$/.test(id))
    throw Error("Coordinator identity is ambiguous or unavailable");
  const result = await docker([
    "container",
    "inspect",
    "--format",
    '{"Id":{{json .Id}},"Image":{{json .Image}},"ConfigImage":{{json .Config.Image}}}',
    id,
  ]);
  expectOk(result, "Docker coordinator identity");
  if (result.stdout.length > 4096) throw Error("Coordinator observation exceeds its bound");
  const row = JSON.parse(result.stdout) as Record<string, unknown> | null;
  if (
    !row ||
    row.Id !== id ||
    typeof row.Image !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row.Image) ||
    typeof row.ConfigImage !== "string" ||
    row.ConfigImage.length > 512 ||
    /[\0\r\n]/.test(row.ConfigImage)
  )
    throw Error("Coordinator identity is unavailable");
  return { imageId: row.Image, reference: row.ConfigImage };
}

async function assertCoordinatorSelection(manifest: ReleaseManifest, docker: ReleaseDockerRunner) {
  const current = await inspectCoordinator(docker);
  if (!current) return;
  const reference = manifest.images["data-manager"];
  if (current.reference !== reference) throw Error(coordinatorGuidance);
  const image = await docker(["image", "inspect", "--format", "{{.Id}}", reference]);
  expectOk(image, "Docker coordinator image");
  if (image.stdout.trim() !== current.imageId)
    throw Error("Coordinator image identity is unavailable; selection was not changed");
}

/** Pull the aggregate release pointer and return its validated manifest. */
export async function resolveReleaseManifest(
  docker: ReleaseDockerRunner = defaultDocker,
  infraDir = repoPaths().infraDir,
): Promise<ReleaseManifest> {
  const channel = appliedReleaseChannel(infraDir);
  if (channel.kind === "disabled") {
    throw new Error(`release resolution is disabled (${RELEASE_SELECTOR_ENV}=local)`);
  }
  const manifestImage = channel.manifestImage;
  const pulled = await docker(["pull", manifestImage]);
  expectOk(pulled, `docker pull ${manifestImage}`);
  const digest = coreServices.releaseDigestFromPull(`${pulled.stdout}\n${pulled.stderr}`);
  const inspected = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    `${channel.selection.manifestRepository}@${digest}`,
  ]);
  expectOk(inspected, "docker image inspect release-manifest");
  const imageId = inspected.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error("Docker returned an invalid release-manifest image id");
  const created = await docker(["create", imageId, "true"]);
  expectOk(created, "docker create release-manifest");
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    throw new Error("Docker returned an invalid release-manifest container id");
  }
  const temp = mkdtempSync(join(tmpdir(), "openmapx-release-"));
  const manifestPath = join(temp, "release-manifest.json");
  try {
    expectOk(
      await docker(["cp", `${containerId}:${RELEASE_MANIFEST_CONTAINER_PATH}`, manifestPath]),
      "docker cp release-manifest.json",
    );
    const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"), channel.imagePrefix);
    coreServices.validateResolvedSelection(channel.selection, manifest, digest);
    expectOk(
      await docker(["pull", manifest.images["privacy-backup"]]),
      `docker pull ${manifest.images["privacy-backup"]}`,
    );
    return manifest;
  } finally {
    await docker(["rm", "-f", containerId]).catch(() => undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Write the overlay and its evidence atomically into the agent's release state. */
export function writeReleaseOverlay(manifest: ReleaseManifest, opts: ReleaseStateLocation = {}) {
  return writeReleaseComposeArtifacts(manifest, opts.infraDir ?? repoPaths().infraDir, {
    uid: opts.uid,
  }).overlayPath;
}

export function touchesReleasePinnedServices(serviceIds: readonly string[]): boolean {
  return serviceIds.some((id) => (RELEASE_PINNED_SERVICE_IDS as readonly string[]).includes(id));
}

export type ReleaseOverlayState =
  | { status: "present"; path: string }
  | { status: "resolved"; path: string; release: string }
  | { status: "disabled" }
  | { status: "unpinned"; reason: string }
  | { status: "held"; reason: string };

/**
 * Make sure `docker-compose.release.yml` exists before a command that would
 * otherwise start release runtime images from their manifest `:latest` tags
 * without the release lockfile's atomic release selection. Never
 * overwrites an existing overlay — the admin updater and `compose release`
 * own deliberate release changes.
 */
export async function ensureReleaseOverlay(
  opts: {
    docker?: ReleaseDockerRunner;
    releaseStoreLock?: coreServices.ReleaseStoreLock;
  } & ReleaseStateLocation = {},
): Promise<ReleaseOverlayState> {
  const infraDir = opts.infraDir ?? repoPaths().infraDir;
  // An earlier release's selection is carried over first, if it can be.
  if (!opts.releaseStoreLock)
    await coreServices.migrateLegacyReleaseState(infraDir, { uid: opts.uid });
  const path = releaseState(opts).overlay;
  const selected = readSelection(path, opts);
  if (selected) {
    assertCompatibleSelection(selected, infraDir);
    return { status: "present", path };
  }
  // An operator running local images opts out once instead of paying a
  // failed registry pull (and a warning) on every start.
  if (appliedReleaseChannel(infraDir).kind === "disabled") return { status: "disabled" };
  let acquired: coreServices.ReleaseStoreLock | undefined;
  try {
    const paths = releaseState(opts);
    coreServices.ensureReleaseStateDirectory(paths.store, { uid: opts.uid });
    if (!opts.releaseStoreLock)
      acquired = await coreServices.acquireReleaseStoreLock(paths.store, {}, { failIfBusy: true });
    // Up/pull may have observed absence before another owner selected a release.
    const current = readSelection(path, opts);
    if (current) {
      assertCompatibleSelection(current, infraDir);
      return { status: "present", path };
    }
    assertNoReleaseTransaction(paths.store);
    const held = coreServices.releaseSelectionHold(infraDir, { uid: opts.uid });
    if (held) return { status: "held", reason: held };
    let manifest: ReleaseManifest;
    try {
      manifest = await resolveReleaseManifest(opts.docker, infraDir);
    } catch (error) {
      return { status: "unpinned", reason: (error as Error).message };
    }
    await assertCoordinatorSelection(manifest, opts.docker ?? defaultDocker);
    writeReleaseOverlay(manifest, opts);
    return { status: "resolved", path, release: manifest.release };
  } catch (error) {
    return { status: "held", reason: (error as Error).message };
  } finally {
    acquired?.release();
  }
}

export function unpinnedReleaseWarning(reason: string): string {
  return (
    `No ${repoPaths().composeReleasePath} and the release lockfile could not be resolved (${reason}). ` +
    "Refusing to start release runtime images without atomic release selection. " +
    "Run `pnpm openmapx compose release` once the registry is reachable, or set " +
    `${RELEASE_SELECTOR_ENV}=local to run local images deliberately.`
  );
}

/** The overlay's selection; an overlay anyone but the agent's user could write is refused. */
function readSelection(
  path: string,
  opts: ReleaseStateLocation,
): coreServices.ReleaseComposeSelection | null {
  const raw = coreServices.readReleaseOverlayFile(path, { uid: opts.uid });
  return raw === null ? null : coreServices.parseReleaseComposeSelection(raw);
}

function assertCompatibleSelection(
  selected: coreServices.ReleaseComposeSelection,
  infraDir: string,
) {
  const channel = appliedReleaseChannel(infraDir);
  const prefix =
    channel.kind === "enabled" ? channel.imagePrefix : selected.images.api?.split("/api@")[0];
  if (
    !selected.release ||
    !prefix ||
    !coreServices.RELEASE_IMAGE_NAMES.every((name) =>
      selected.images[name]?.startsWith(`${prefix}/${name}@`),
    )
  )
    throw Error(
      "Existing release overlay is malformed or belongs to another configured repository; explicitly reselect or clear it",
    );
}

/** Read-only local status; an existing overlay still applies when resolution is disabled. */
export function releaseStatusLines(
  path = repoPaths().composeReleasePath,
  opts: Pick<ReleaseStateLocation, "uid"> = {},
): string[] {
  const selected = readSelection(path, opts);
  const channel = appliedReleaseChannel();
  const disabled = channel.kind === "disabled";
  if (!selected)
    return [
      disabled
        ? "Release pinning disabled; no release overlay selected."
        : "No release lockfile selected locally. Run `pnpm openmapx compose release`.",
    ];
  return [
    `Configured selection: ${process.env.OPENMAPX_RELEASE ?? "main"}; existing pins remain selected until explicit reselection.`,
    ...(disabled ? ["Release resolution disabled; existing overlay still applies."] : []),
    `Selected release: ${selected.release ?? "unknown (legacy or modified overlay)"}`,
    ...coreServices.RELEASE_IMAGE_NAMES.map(
      (name) => `${name}: ${selected.images[name] ?? "unknown"}`,
    ),
    "These are locally selected pins; running containers have not been inspected.",
  ];
}

export async function selectRelease(
  opts: {
    resolve?: () => Promise<ReleaseManifest>;
    report?: (line: string) => void;
    docker?: ReleaseDockerRunner;
  } & ReleaseStateLocation = {},
): Promise<{ path: string; release: string }> {
  const { directory, store, overlay: path } = releaseState(opts);
  coreServices.ensureReleaseStateDirectory(directory, { uid: opts.uid });
  coreServices.ensureReleaseStateDirectory(store, { uid: opts.uid });
  const lock = await coreServices.acquireReleaseStoreLock(store, {}, { failIfBusy: true });
  try {
    assertNoReleaseTransaction(store);
    const previous = readSelection(path, opts);
    const manifest = await (
      opts.resolve ?? (() => resolveReleaseManifest(defaultDocker, opts.infraDir))
    )();
    await assertCoordinatorSelection(manifest, opts.docker ?? defaultDocker);
    const report = opts.report ?? (() => undefined);
    report(
      `Previous release: ${previous ? (previous.release ?? "unknown (legacy or modified overlay)") : "none"}`,
    );
    report(`Candidate release: ${manifest.release}`);
    for (const name of coreServices.RELEASE_IMAGE_NAMES) {
      const before = previous?.images[name]?.split("@")[1];
      const after = manifest.images[name].split("@")[1];
      report(
        `${name}: ${before ? (before === after ? "reused" : "changed") : "previous digest unknown"} (${before ?? "unknown"} → ${after})`,
      );
    }
    writeReleaseOverlay(manifest, opts);
    return { path, release: manifest.release };
  } finally {
    lock.release();
  }
}

/** Clear only selection with the shared conditional release-store writer. */
export async function clearReleaseSelection(
  opts: ReleaseStateLocation & { expectedReleaseId?: string; docker?: ReleaseDockerRunner } = {},
): Promise<{ path: string; cleared: boolean }> {
  const path = releaseState(opts).overlay;
  let raw: Buffer | undefined;
  try {
    lstatSync(path);
    coreServices.assertReleaseStateDirectory(dirname(path), { uid: opts.uid });
    raw = coreServices.readReleaseStateBytes(path, 128 * 1024, { uid: opts.uid });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error("Release selection overlay is unsafe", { cause: error });
  }
  let selected: coreServices.ReleaseComposeSelection | undefined;
  if (raw !== undefined) {
    try {
      selected = coreServices.parseReleaseComposeSelection(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      // A malformed overlay is already unusable; retain conditional recovery.
    }
    if (selected?.images["data-manager"]) {
      const current = await inspectCoordinator(opts.docker ?? defaultDocker);
      if (current?.reference === selected.images["data-manager"]) throw Error(coordinatorGuidance);
    }
  }
  return coreServices.clearReleaseComposeSelection({
    infraDir: opts.infraDir ?? repoPaths().infraDir,
    uid: opts.uid,
    path,
    expectedReleaseId: opts.expectedReleaseId ?? selected?.release ?? undefined,
    expectedOverlayDigest:
      raw === undefined ? null : createHash("sha256").update(raw).digest("hex"),
  });
}
