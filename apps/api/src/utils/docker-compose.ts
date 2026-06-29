import { execFile as execFileCb, spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { repoPaths } from "@openmapx/core/server";

const execFile = promisify(execFileCb);

function composePath(): string {
  return repoPaths().composeOutPath;
}

export interface PsEntry {
  service: string;
  state: "running" | "exited" | "restarting" | "created" | "paused" | "not-running";
  container: string;
}

export async function dockerComposePs(): Promise<PsEntry[]> {
  try {
    const { stdout } = await execFile(
      "docker",
      ["compose", "-f", composePath(), "ps", "--format", "json"],
      { timeout: 15_000 },
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((l) => {
      const obj = JSON.parse(l) as { Name: string; Service: string; State: string };
      return { container: obj.Name, service: obj.Service, state: obj.State as PsEntry["state"] };
    });
  } catch {
    return [];
  }
}

export async function dockerComposeAction(
  serviceId: string,
  action: "start" | "stop" | "restart" | "recreate" | "remove" | "pull",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const serviceArgs = serviceId ? [serviceId] : [];
  const args =
    action === "start"
      ? ["up", "-d", ...serviceArgs]
      : action === "pull"
        ? // Re-fetch the image so a moving tag (e.g. :latest) is refreshed; a
          // following `up -d` then recreates the container on the new digest.
          ["pull", ...serviceArgs]
        : action === "recreate"
          ? // Force-recreate so a rotated secret (same key/path, new file content)
            // is always picked up, not just config-shape changes.
            ["up", "-d", "--force-recreate", ...serviceArgs]
          : action === "stop"
            ? ["stop", ...serviceArgs]
            : action === "remove"
              ? // Stop + remove the container (clean teardown when uninstalling an
                // extension's service). `-s` stops first, `-f` skips confirmation.
                ["rm", "-sf", ...serviceArgs]
              : ["restart", ...serviceArgs];
  // Image pulls fetch from a registry over the network and can legitimately
  // take several minutes for a large image on a slow link; every other action
  // is a local container operation that should stay snappy. A too-short pull
  // budget would surface as an opaque non-zero exit, indistinguishable from a
  // real registry error.
  const timeout = action === "pull" ? 600_000 : 120_000;
  try {
    const { stdout, stderr } = await execFile("docker", ["compose", "-f", composePath(), ...args], {
      timeout,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
    const stdout = (err as { stdout?: string }).stdout ?? "";
    // The actual reason (e.g. `error from registry: unauthorized`, a network
    // failure, or a kill on timeout) lands on stderr — surface it so callers
    // can log *why* a pull/recreate failed instead of a bare exit code.
    const stderr = (err as { stderr?: string }).stderr ?? "";
    return { exitCode: typeof code === "number" ? code : 1, stdout, stderr };
  }
}

export function dockerComposeLogs(
  serviceId: string,
  out: ServerResponse,
  opts: { tail: number },
): void {
  const child = spawn("docker", [
    "compose",
    "-f",
    composePath(),
    "logs",
    "-f",
    `--tail=${opts.tail}`,
    serviceId,
  ]);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on("close", () => out.end());
}
