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
): Promise<{ exitCode: number; stdout: string }> {
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
  try {
    const { stdout } = await execFile("docker", ["compose", "-f", composePath(), ...args], {
      timeout: 120_000,
    });
    return { exitCode: 0, stdout: stdout ?? "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
    const stdout = (err as { stdout?: string }).stdout ?? "";
    return { exitCode: typeof code === "number" ? code : 1, stdout };
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
