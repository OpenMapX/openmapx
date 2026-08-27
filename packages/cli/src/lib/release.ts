import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { repoPaths } from "./paths";

const {
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_MANIFEST_IMAGE_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  parseReleaseManifest,
  releaseChannel,
  renderReleaseCompose,
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
    return parseReleaseManifest(readFileSync(manifestPath, "utf8"));
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
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, renderReleaseCompose(manifest), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return path;
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
 * without the release manifest's atomic cross-service pin. Never
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
    `No ${repoPaths().composeReleasePath} and the release manifest could not be resolved (${reason}). ` +
    "Refusing to start release runtime images without the atomic digest pins. " +
    "Run `pnpm openmapx compose release` once the registry is reachable, or set " +
    `${RELEASE_MANIFEST_IMAGE_ENV}="" to run local images deliberately.`
  );
}
