import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";
import { cliProcessOptions } from "./execution-deadline";
import { repoPaths } from "./paths";

export async function dockerCompose(
  args: string[],
  rootDir?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const paths = repoPaths(rootDir);
  const result = await execa("docker", [...coreServices.stackComposeArgs(paths), ...args], {
    ...cliProcessOptions(),
    cwd: paths.infraDir,
    reject: false,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

/**
 * Run a one-off `docker run` (not `docker compose run`). Used for ephemeral
 * helper containers — e.g. the deep-probe curl container — that attach to an
 * existing compose network via `--network`, a flag `docker compose run` does
 * not accept.
 */
export async function dockerRun(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("docker", ["run", ...args], { ...cliProcessOptions(), reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

export async function dockerComposeStream(args: string[]): Promise<number> {
  const paths = repoPaths();
  const sub = execa("docker", [...coreServices.stackComposeArgs(paths), ...args], {
    ...cliProcessOptions(),
    cwd: paths.infraDir,
    stdio: "inherit",
    reject: false,
  });
  const result = await sub;
  return result.exitCode ?? 0;
}

/**
 * Return the subset of the given compose-service ids that have a container
 * currently running. Uses `docker compose ps` against the generated compose
 * file; services that aren't in the file or don't have a running container
 * are omitted. Silently returns an empty array when docker is unavailable or
 * the compose file hasn't been rendered yet — callers treat this as "we
 * couldn't verify, proceed with a warning".
 */
export async function runningComposeServices(serviceIds: string[]): Promise<string[]> {
  if (serviceIds.length === 0) return [];
  const result = await dockerCompose(["ps", "--status=running", "--services", ...serviceIds]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && serviceIds.includes(line));
}
/** Artifact movement must prove consumers stopped; acquisition failure is unknown. */
export async function runningComposeServicesStrict(
  serviceIds: string[],
  rootDir?: string,
): Promise<string[]> {
  if (!serviceIds.length) return [];
  const result = await dockerCompose(
    ["ps", "--status=running", "--services", ...serviceIds],
    rootDir,
  );
  if (result.exitCode !== 0)
    throw Error("Container state is unavailable; no prepared artifacts were moved");
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => serviceIds.includes(value));
}
