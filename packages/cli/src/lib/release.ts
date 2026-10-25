import { lstatSync, mkdtempSync, readFileSync, rmSync, type Stats, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncDirectory } from "@openmapx/core/release-files";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { repoPaths } from "./paths";

const {
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_SELECTOR_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  parseReleaseManifest,
  releaseChannel,
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

export type ReleaseDockerRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number; stderr: string }>;

async function defaultDocker(args: string[]) {
  const result = await execa("docker", args, { reject: false });
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

/** Pull the aggregate release pointer and return its validated manifest. */
export async function resolveReleaseManifest(
  docker: ReleaseDockerRunner = defaultDocker,
): Promise<ReleaseManifest> {
  const channel = releaseChannel();
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
  | { status: "unpinned"; reason: string };

/**
 * Make sure `docker-compose.release.yml` exists before a command that would
 * otherwise start release runtime images from their manifest `:latest` tags
 * without the release lockfile's atomic release selection. Never
 * overwrites an existing overlay — the admin updater and `compose release`
 * own deliberate release changes.
 */
export async function ensureReleaseOverlay(
  opts: { docker?: ReleaseDockerRunner } & ReleaseStateLocation = {},
): Promise<ReleaseOverlayState> {
  const path = releaseState(opts).overlay;
  const selected = readSelection(path, opts);
  if (selected) {
    const channel = releaseChannel();
    const prefix =
      channel.kind === "enabled" ? channel.imagePrefix : selected?.images.api?.split("/api@")[0];
    if (
      !selected?.release ||
      !prefix ||
      !coreServices.RELEASE_IMAGE_NAMES.every((name) =>
        selected.images[name]?.startsWith(`${prefix}/${name}@`),
      )
    )
      throw new Error(
        "Existing release overlay is malformed or belongs to another configured repository; explicitly reselect or clear it",
      );
    return { status: "present", path };
  }
  // An operator running local images opts out once instead of paying a
  // failed registry pull (and a warning) on every start.
  if (releaseChannel().kind === "disabled") return { status: "disabled" };
  try {
    const manifest = await resolveReleaseManifest(opts.docker);
    writeReleaseOverlay(manifest, opts);
    return { status: "resolved", path, release: manifest.release };
  } catch (error) {
    return { status: "unpinned", reason: (error as Error).message };
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

/** Read-only local status; an existing overlay still applies when resolution is disabled. */
export function releaseStatusLines(
  path = repoPaths().composeReleasePath,
  opts: Pick<ReleaseStateLocation, "uid"> = {},
): string[] {
  const selected = readSelection(path, opts);
  const disabled = releaseChannel().kind === "disabled";
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
  } & ReleaseStateLocation = {},
): Promise<{ path: string; release: string }> {
  const path = releaseState(opts).overlay;
  const previous = readSelection(path, opts);
  const manifest = await (opts.resolve ?? resolveReleaseManifest)();
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
}

/**
 * Clear only local Compose selection, the overlay in the agent's release state;
 * preserve evidence still mounted by running services. An overlay of an
 * earlier release in `infra/docker` is left alone: nothing reads it any more.
 */
export async function clearReleaseSelection(
  opts: ReleaseStateLocation = {},
): Promise<{ path: string; cleared: boolean }> {
  const { directory, store, overlay: path } = releaseState(opts);
  coreServices.ensureReleaseStateDirectory(directory, { uid: opts.uid });
  coreServices.ensureReleaseStateDirectory(store, { uid: opts.uid });
  const lock = await coreServices.acquireReleaseStoreLock(store, {}, { failIfBusy: true });
  try {
    try {
      lstatSync(join(store, "transaction.json"));
      throw new Error(
        "Release transaction is active; finish or recover the update before clearing selection",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let selected: Stats;
    try {
      selected = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, cleared: false };
      throw error;
    }
    const problem = coreServices.releaseStateFileProblem(
      selected,
      coreServices.RELEASE_STORE_LIMITS.manifestBytes,
      { uid: opts.uid },
    );
    if (problem) throw new Error(`Release selection overlay is unsafe: ${path} ${problem}`);
    unlinkSync(path);
    fsyncDirectory(directory);
    return { path, cleared: true };
  } finally {
    lock.release();
  }
}
