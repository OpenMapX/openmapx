import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { cliProcessOptions } from "./execution-deadline";
import { repoPaths } from "./paths";

const {
  RELEASE_MANIFEST_CONTAINER_PATH,
  RELEASE_SELECTOR_ENV,
  RELEASE_PINNED_SERVICE_IDS,
  parseReleaseManifest,
} = coreServices;

export type ReleaseManifest = coreServices.ReleaseManifest;
const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024;

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
  "(/admin/system/updates). " +
  "For recovery, reselect the exact immutable pin used by the existing Data Manager.";

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

export async function assertCoordinatorSelection(
  manifest: ReleaseManifest,
  docker: ReleaseDockerRunner,
) {
  const current = await inspectCoordinator(docker);
  if (!current) return;
  const reference = manifest.images["data-manager"];
  if (current.reference !== reference) throw Error(coordinatorGuidance);
  const image = await docker(["image", "inspect", "--format", "{{.Id}}", reference]);
  expectOk(image, "Docker coordinator image");
  if (image.stdout.trim() !== current.imageId)
    throw Error("Coordinator image identity is unavailable; selection was not changed");
}

/** Read only the copied file inside our private temporary directory. Artifact
 * file permissions need not match mutable deployment-state permissions. */
function readManifestFromPrivateTemp(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_RELEASE_MANIFEST_BYTES
    )
      throw Error("Release manifest exceeds its file bound");
    const bytes = Buffer.alloc(before.size);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) throw Error("Release manifest changed while reading");
      used += count;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("Release manifest changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}

/** Resolve only the small immutable metadata image, not application/helper images. */
export async function resolveReleaseCandidate(
  docker: ReleaseDockerRunner = defaultDocker,
  infraDir = repoPaths().infraDir,
): Promise<{ manifest: ReleaseManifest; ociDigest: string }> {
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
    const manifest = parseReleaseManifest(
      readManifestFromPrivateTemp(manifestPath),
      channel.imagePrefix,
    );
    coreServices.validateResolvedSelection(channel.selection, manifest, digest);
    return { manifest, ociDigest: digest };
  } finally {
    await docker(["rm", "-f", containerId]).catch(() => undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The release manifest the configured selection resolves to. */
export async function resolveReleaseManifest(
  docker: ReleaseDockerRunner = defaultDocker,
  infraDir = repoPaths().infraDir,
): Promise<ReleaseManifest> {
  const { manifest } = await resolveReleaseCandidate(docker, infraDir);
  return manifest;
}

/** Check a candidate and cache its manifest; the pins and running services stay as they are. */
export async function checkRelease(opts: { docker?: ReleaseDockerRunner; infraDir?: string } = {}) {
  const infraDir = opts.infraDir ?? repoPaths().infraDir;
  const selection = coreServices.readAppliedReleaseSelection(infraDir);
  if (selection.kind === "local") throw new coreServices.ReleaseChannelDisabledError();
  const candidate = await resolveReleaseCandidate(opts.docker, infraDir);
  const cached = coreServices.cacheReleaseManifest(infraDir, candidate.manifest);
  return { ...candidate, ...cached, configuredSelector: selection.selector };
}

export function touchesReleasePinnedServices(serviceIds: readonly string[]): boolean {
  return serviceIds.some((id) => (RELEASE_PINNED_SERVICE_IDS as readonly string[]).includes(id));
}

/**
 * The release a start renders: the applied generation's pins, else, at
 * bootstrap, the release the configured selection resolves to now. Null under
 * `OPENMAPX_RELEASE=local`. Throws when release images would start without
 * pins.
 */
export async function releaseForStart(
  opts: { docker?: ReleaseDockerRunner; infraDir?: string } = {},
): Promise<{ manifest: ReleaseManifest | null; resolved: boolean }> {
  const infraDir = opts.infraDir ?? repoPaths().infraDir;
  const applied = coreServices.readAppliedRelease(infraDir);
  if (applied) return { manifest: applied.manifest, resolved: false };
  if (appliedReleaseChannel(infraDir).kind === "disabled")
    return { manifest: null, resolved: false };
  let manifest: ReleaseManifest;
  try {
    manifest = await resolveReleaseManifest(opts.docker, infraDir);
  } catch (error) {
    throw new Error(unpinnedReleaseWarning((error as Error).message));
  }
  await assertCoordinatorSelection(manifest, opts.docker ?? defaultDocker);
  coreServices.cacheReleaseManifest(infraDir, manifest);
  return { manifest, resolved: true };
}

export function unpinnedReleaseWarning(reason: string): string {
  return (
    `The applied configuration pins no release and the release manifest could not be resolved (${reason}). ` +
    "Refusing to start release images without pins. " +
    "Select a release with `pnpm openmapx compose release` once the registry is reachable, or set " +
    `${RELEASE_SELECTOR_ENV}=local to run local images deliberately.`
  );
}

/** What the applied generation pins, read locally without the registry. */
export function releaseStatusLines(infraDir = repoPaths().infraDir): string[] {
  const applied = coreServices.readAppliedRelease(infraDir);
  const disabled = appliedReleaseChannel(infraDir).kind === "disabled";
  if (!applied)
    return [
      disabled
        ? "Release pinning disabled; the applied configuration pins no release."
        : "The applied configuration pins no release. Run `pnpm openmapx compose release`.",
    ];
  return [
    `Configured selection: ${process.env.OPENMAPX_RELEASE ?? "main"}; the pins stay until a release is selected or cleared.`,
    ...(disabled ? ["Release resolution disabled; the applied pins still apply."] : []),
    `Pinned release: ${applied.manifest.release} (manifest ${applied.manifestDigest})`,
    ...coreServices.RELEASE_IMAGE_NAMES.map((name) => `${name}: ${applied.manifest.images[name]}`),
    "These are the applied configuration's pins; running containers have not been inspected.",
  ];
}

/** Resolves a release and reports how its pins differ from the applied ones; nothing is written. */
export async function selectRelease(
  opts: {
    resolve?: () => Promise<ReleaseManifest>;
    report?: (line: string) => void;
    docker?: ReleaseDockerRunner;
    infraDir?: string;
  } = {},
): Promise<ReleaseManifest> {
  const infraDir = opts.infraDir ?? repoPaths().infraDir;
  const previous = coreServices.readAppliedRelease(infraDir)?.manifest;
  const manifest = await (
    opts.resolve ?? (() => resolveReleaseManifest(defaultDocker, infraDir))
  )();
  await assertCoordinatorSelection(manifest, opts.docker ?? defaultDocker);
  coreServices.cacheReleaseManifest(infraDir, manifest);
  const report = opts.report ?? (() => undefined);
  report(`Previous release: ${previous?.release ?? "none"}`);
  report(`Candidate release: ${manifest.release}`);
  for (const name of coreServices.RELEASE_IMAGE_NAMES) {
    const before = previous?.images[name].split("@")[1];
    const after = manifest.images[name].split("@")[1];
    report(
      `${name}: ${before ? (before === after ? "reused" : "changed") : "no previous pin"} (${before ?? "none"} → ${after})`,
    );
  }
  return manifest;
}

/** Refuses to clear pins whose data-manager image the running coordinator uses. */
export async function assertReleaseClearable(
  opts: { docker?: ReleaseDockerRunner; infraDir?: string } = {},
): Promise<string | null> {
  const applied = coreServices.readAppliedRelease(opts.infraDir ?? repoPaths().infraDir);
  if (!applied) return null;
  const current = await inspectCoordinator(opts.docker ?? defaultDocker);
  if (current?.reference === applied.manifest.images["data-manager"])
    throw Error(coordinatorGuidance);
  return applied.manifest.release;
}
