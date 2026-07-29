import { execFile as execFileCallback } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { repoPaths } from "@openmapx/core/server";

const execFile = promisify(execFileCallback);

const HELPER_LABEL = "com.openmapx.maintenance=app-api-replacement";
const UPDATE_JOB_LABEL = "com.openmapx.update.job";
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

type DockerResult = { stdout: string; stderr: string };
type ExecDocker = (args: string[], timeoutMs?: number) => Promise<DockerResult>;

export interface AppApiReplacementPlan {
  helperContainerId: string;
  previousContainerId: string;
  expectedImageId: string;
  outcomeFile: string;
}

export type AppApiReplacementOutcome = "applied" | "rolled-back" | "failed";

export interface AppApiRuntimeInfo {
  containerId: string;
  imageId: string;
  updateJobId: string | null;
}

async function defaultExecDocker(args: string[], timeoutMs = 30_000): Promise<DockerResult> {
  const { stdout, stderr } = await execFile("docker", args, {
    timeout: timeoutMs,
    maxBuffer: 10_000_000,
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

function singleLine(value: string, description: string): string {
  const lines = value
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error(`Could not resolve exactly one ${description}`);
  return lines[0];
}

function errorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  const stdout = (error as { stdout?: string }).stdout?.trim();
  if (stderr) return stderr.split("\n").slice(-6).join("; ");
  if (stdout) return stdout.split("\n").slice(-6).join("; ");
  return error instanceof Error ? error.message : String(error);
}

async function removeHelper(containerId: string, execDocker: ExecDocker): Promise<void> {
  await execDocker(["rm", "-f", containerId]).catch(() => undefined);
}

/**
 * Create, but do not start, the sibling container that will replace app-api.
 * Creating it before the durable checkpoint lets setup errors fail normally
 * while the current API is still alive.
 */
export async function prepareAppApiReplacement(
  jobId: string,
  targetImage: string,
  execDocker: ExecDocker = defaultExecDocker,
): Promise<AppApiReplacementPlan> {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error("Invalid update job id");

  const hostDir = process.env.OPENMAPX_HOST_DIR?.trim();
  if (!hostDir || !isAbsolute(hostDir) || hostDir.includes(",")) {
    throw new Error("OPENMAPX_HOST_DIR must be an absolute bind-mount-safe path");
  }
  const composePath = repoPaths().composeOutPath;
  const projectDir = dirname(composePath);
  const composeRelativePath = relative(hostDir, composePath);
  if (composeRelativePath.startsWith("..") || isAbsolute(composeRelativePath)) {
    throw new Error("The rendered Compose file must be inside OPENMAPX_HOST_DIR");
  }

  const currentContainer = singleLine(
    (
      await execDocker([
        "compose",
        "--project-directory",
        dirname(composePath),
        "-f",
        composePath,
        "ps",
        "-q",
        "app-api",
      ])
    ).stdout,
    "running app-api container",
  );
  const previousContainerId = singleLine(
    (await execDocker(["container", "inspect", "--format", "{{.Id}}", currentContainer])).stdout,
    "app-api container id",
  );
  const currentImageId = singleLine(
    (await execDocker(["container", "inspect", "--format", "{{.Image}}", previousContainerId]))
      .stdout,
    "current app-api image id",
  );
  const expectedImageId = singleLine(
    (await execDocker(["image", "inspect", "--format", "{{.Id}}", targetImage])).stdout,
    "target app-api image id",
  );
  if (!CONTAINER_ID.test(previousContainerId)) {
    throw new Error("Docker returned an invalid app-api container id");
  }
  if (!IMAGE_ID.test(currentImageId) || !IMAGE_ID.test(expectedImageId)) {
    throw new Error("Docker returned an invalid app-api image id");
  }

  const helperName = `openmapx-app-api-updater-${jobId}`;
  const outcomeFile = `${projectDir}/.maintenance/app-api-${jobId}.status`;
  const helperScript = [
    "project_dir=$1",
    "compose_file=$2",
    "previous_image=$3",
    "job_id=$4",
    "outcome_file=$5",
    'mkdir -p "$(dirname "$outcome_file")"',
    "target_override=/tmp/app-api-target.yml",
    "rollback_override=/tmp/app-api-rollback.yml",
    'printf \'services:\\n  app-api:\\n    labels:\\n      com.openmapx.update.job: "%s"\\n\' "$job_id" > "$target_override"',
    'if docker compose --project-directory "$project_dir" -f "$compose_file" -f "$target_override" up -d --force-recreate --no-deps --wait --wait-timeout 180 app-api; then',
    "  printf 'applied\\n' > \"$outcome_file.tmp\"",
    '  mv "$outcome_file.tmp" "$outcome_file"',
    "  exit 0",
    "else",
    "  target_status=$?",
    "fi",
    'printf \'services:\\n  app-api:\\n    image: "%s"\\n    labels:\\n      com.openmapx.update.job: "%s"\\n\' "$previous_image" "$job_id" > "$rollback_override"',
    'if docker compose --project-directory "$project_dir" -f "$compose_file" -f "$rollback_override" up -d --force-recreate --no-deps --wait --wait-timeout 180 app-api; then',
    "  printf 'rolled-back\\n' > \"$outcome_file.tmp\"",
    "else",
    "  printf 'failed\\n' > \"$outcome_file.tmp\"",
    "fi",
    'mv "$outcome_file.tmp" "$outcome_file"',
    'exit "$target_status"',
  ].join("\n");
  const helperContainerId = singleLine(
    (
      await execDocker([
        "create",
        "--rm",
        "--name",
        helperName,
        "--label",
        HELPER_LABEL,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
        "--mount",
        `type=bind,src=${hostDir},dst=${hostDir},readonly`,
        "--mount",
        `type=bind,src=${projectDir},dst=${projectDir}`,
        "--workdir",
        projectDir,
        "--entrypoint",
        "/bin/sh",
        currentImageId,
        "-c",
        helperScript,
        "openmapx-app-api-replacement",
        projectDir,
        composePath,
        currentImageId,
        jobId,
        outcomeFile,
      ])
    ).stdout,
    "app-api update helper container id",
  );
  if (!CONTAINER_ID.test(helperContainerId)) {
    await removeHelper(helperContainerId, execDocker);
    throw new Error("Docker returned an invalid update helper container id");
  }

  return { helperContainerId, previousContainerId, expectedImageId, outcomeFile };
}

/** Remove a prepared helper when persisting its checkpoint fails. */
export async function discardAppApiReplacement(
  plan: AppApiReplacementPlan,
  execDocker: ExecDocker = defaultExecDocker,
): Promise<void> {
  await removeHelper(plan.helperContainerId, execDocker);
}

/**
 * Start and attach to the sibling helper. On success the helper replaces this
 * container, so the caller is terminated and this promise never resolves. If
 * it does resolve or reject while the caller is alive, the replacement failed.
 */
export async function startAppApiReplacement(
  plan: AppApiReplacementPlan,
  execDocker: ExecDocker = defaultExecDocker,
): Promise<never> {
  try {
    const result = await execDocker(["start", "--attach", plan.helperContainerId], 390_000);
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `App-api replacement helper exited without replacing the current API${detail ? `: ${detail}` : ""}`,
    );
  } catch (error) {
    await removeHelper(plan.helperContainerId, execDocker);
    if (error instanceof Error && error.message.startsWith("App-api replacement helper exited")) {
      throw error;
    }
    throw new Error(`App-api replacement helper failed: ${errorDetail(error)}`, { cause: error });
  }
}

/** Resolve the immutable identity of the API container running this process. */
export async function currentAppApiRuntimeInfo(
  execDocker: ExecDocker = defaultExecDocker,
): Promise<AppApiRuntimeInfo | null> {
  const containerRef = process.env.HOSTNAME?.trim();
  if (!containerRef) return null;
  try {
    const containerId = singleLine(
      (await execDocker(["container", "inspect", "--format", "{{.Id}}", containerRef])).stdout,
      "current app-api container id",
    );
    const imageId = singleLine(
      (await execDocker(["container", "inspect", "--format", "{{.Image}}", containerRef])).stdout,
      "current app-api image id",
    );
    const updateJobId = (
      await execDocker([
        "container",
        "inspect",
        "--format",
        `{{index .Config.Labels "${UPDATE_JOB_LABEL}"}}`,
        containerRef,
      ])
    ).stdout.trim();
    if (!CONTAINER_ID.test(containerId) || !IMAGE_ID.test(imageId)) return null;
    return {
      containerId,
      imageId,
      updateJobId: updateJobId && updateJobId !== "<no value>" ? updateJobId : null,
    };
  } catch {
    return null;
  }
}

function validOutcomeFile(path: string): boolean {
  const maintenanceDir = `${dirname(repoPaths().composeOutPath)}/.maintenance`;
  const relativePath = relative(maintenanceDir, path);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** Wait for the external helper's health-checked apply or rollback result. */
export async function waitForAppApiReplacementOutcome(
  outcomeFile: string,
  timeoutMs = 370_000,
): Promise<AppApiReplacementOutcome | null> {
  if (!validOutcomeFile(outcomeFile)) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const outcome = (await readFile(outcomeFile, "utf8")).trim();
      if (outcome === "applied" || outcome === "rolled-back" || outcome === "failed") {
        return outcome;
      }
    } catch {
      // The helper writes atomically after the target or rollback health check.
    }
    await delay(500);
  }
  return null;
}

export async function removeAppApiReplacementOutcome(outcomeFile: string): Promise<void> {
  if (!validOutcomeFile(outcomeFile)) return;
  await rm(outcomeFile, { force: true }).catch(() => undefined);
}

export const _appApiReplacementTestHelpers = {
  CONTAINER_ID,
  IMAGE_ID,
};
