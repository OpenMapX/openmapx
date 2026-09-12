import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { repoPaths } from "./paths";

const {
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_MANIFEST_IMAGE_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  parseReleaseManifest,
  releaseChannel,
  writeReleaseComposeArtifacts,
} = coreServices;

export type ReleaseManifest = coreServices.ReleaseManifest;

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
    throw new Error(`release resolution is disabled (${RELEASE_MANIFEST_IMAGE_ENV} is empty)`);
  }
  const manifestImage = channel.manifestImage;
  expectOk(await docker(["pull", manifestImage]), `docker pull ${manifestImage}`);
  const created = await docker(["create", manifestImage, "true"]);
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
    const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"));
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

/** Write the overlay atomically next to the generated compose file. */
export function writeReleaseOverlay(
  manifest: ReleaseManifest,
  path = repoPaths().composeReleasePath,
) {
  return writeReleaseComposeArtifacts(manifest, path).overlayPath;
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
  opts: { docker?: ReleaseDockerRunner; path?: string } = {},
): Promise<ReleaseOverlayState> {
  const path = opts.path ?? repoPaths().composeReleasePath;
  if (existsSync(path)) return { status: "present", path };
  // An operator running local images opts out once instead of paying a
  // failed registry pull (and a warning) on every start.
  if (releaseChannel().kind === "disabled") return { status: "disabled" };
  try {
    const manifest = await resolveReleaseManifest(opts.docker);
    writeReleaseOverlay(manifest, path);
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
    `${RELEASE_MANIFEST_IMAGE_ENV}="" to run local images deliberately.`
  );
}

function readSelection(path: string): coreServices.ReleaseComposeSelection | null {
  return existsSync(path)
    ? coreServices.parseReleaseComposeSelection(readFileSync(path, "utf8"))
    : null;
}

/** Read-only local status; an existing overlay still applies when resolution is disabled. */
export function releaseStatusLines(path = repoPaths().composeReleasePath): string[] {
  const selected = readSelection(path);
  const disabled = releaseChannel().kind === "disabled";
  if (!selected)
    return [
      disabled
        ? "Release pinning disabled; no release overlay selected."
        : "No release lockfile selected locally. Run `pnpm openmapx compose release`.",
    ];
  return [
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
    path?: string;
    resolve?: () => Promise<ReleaseManifest>;
    report?: (line: string) => void;
  } = {},
): Promise<{ path: string; release: string }> {
  const path = opts.path ?? repoPaths().composeReleasePath;
  const previous = readSelection(path);
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
  writeReleaseOverlay(manifest, path);
  return { path, release: manifest.release };
}

/** Clear only local Compose selection; preserve evidence still mounted by running services. */
export async function clearReleaseSelection(
  opts: { path?: string } = {},
): Promise<{ path: string; cleared: boolean }> {
  const path = opts.path ?? repoPaths().composeReleasePath;
  const parent = dirname(path);
  const assertDirectory = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Release selection directory is unsafe");
    }
  };
  assertDirectory(parent);
  const store = join(parent, ".ops-agent-releases");
  try {
    mkdirSync(store, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertDirectory(store);
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
    if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1) {
      throw new Error("Release selection overlay is unsafe");
    }
    unlinkSync(path);
    const descriptor = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return { path, cleared: true };
  } finally {
    lock.release();
  }
}
