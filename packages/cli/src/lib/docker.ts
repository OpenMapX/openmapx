import { execa } from "execa";
import { repoPaths } from "./paths";

export async function dockerCompose(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const paths = repoPaths();
  const composeFile = paths.composeOutPath;
  const result = await execa("docker", ["compose", "-f", composeFile, ...args], {
    cwd: paths.infraDir,
    reject: false,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

export async function dockerComposeStream(args: string[]): Promise<number> {
  const paths = repoPaths();
  const composeFile = paths.composeOutPath;
  const sub = execa("docker", ["compose", "-f", composeFile, ...args], {
    cwd: paths.infraDir,
    stdio: "inherit",
    reject: false,
  });
  const result = await sub;
  return result.exitCode ?? 0;
}
