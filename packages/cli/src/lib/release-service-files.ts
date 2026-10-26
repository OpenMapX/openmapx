import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";

/** The selected release's service files, as its operations-agent image embeds them. */
export interface SelectedReleaseServiceFiles {
  files: coreServices.ReleaseServiceFiles;
  release: string | null;
  image: string;
  /** The source revision the image was built from, from its OCI label. */
  revision: string | null;
}

/** What the release image's fixed CLI prints them with. */
export const RELEASE_FILES_COMMAND = ["node", "dist/cli.mjs", "compose", "release-files"];

/**
 * The service files a host render uses: those of the release the overlay
 * selects, read from its pinned operations-agent image (the host CLI runs
 * the checkout's code, which is not the release). `null` when this process
 * is the release's own CLI, or under `OPENMAPX_RELEASE=local`, where the
 * checkout's files apply; `"none"` before a release is selected.
 */
export async function selectedReleaseServiceFiles(
  infraDir: string,
): Promise<SelectedReleaseServiceFiles | "none" | null> {
  if (coreServices.readEmbeddedReleaseServiceFiles()) return null;
  if (coreServices.releaseChannel().kind === "disabled") return null;
  const overlay = coreServices.readReleaseOverlayFile(
    coreServices.releaseStatePaths(infraDir).overlay,
  );
  if (overlay === null) return "none";
  const selection = coreServices.parseReleaseComposeSelection(overlay);
  const image = selection.images["ops-agent"];
  if (!image) throw new Error("The release overlay pins no operations-agent image");
  const unreadable = (reason: string) =>
    new Error(
      `The selected release's service files could not be read from its operations-agent image ${image}: ${reason}. Render uses the release's files, so it stops here. If the selected release predates this checkout, select this checkout's release: pnpm openmapx compose release.`,
    );
  const run = await execa(
    "docker",
    ["run", "--rm", "--network", "none", "--read-only", image, ...RELEASE_FILES_COMMAND],
    { reject: false, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.exitCode !== 0) {
    throw unreadable(
      String(run.stderr ?? "")
        .trim()
        .split("\n")
        .slice(-1)[0] || `exit ${run.exitCode}`,
    );
  }
  let files: coreServices.ReleaseServiceFiles;
  try {
    files = coreServices.parseReleaseServiceFiles(String(run.stdout ?? ""));
  } catch (error) {
    throw unreadable((error as Error).message);
  }
  const inspected = await execa(
    "docker",
    [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      image,
    ],
    { reject: false, timeout: 30_000 },
  );
  const revision = String(inspected.stdout ?? "").trim();
  return {
    files,
    release: selection.release,
    image,
    revision: inspected.exitCode === 0 && /^[a-f0-9]{40}$/.test(revision) ? revision : null,
  };
}
