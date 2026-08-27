import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import { type RepoPaths, repoPaths } from "@openmapx/core/server";
import {
  type ApiOpsClient,
  ApiOpsError,
  createApiOpsClient,
  executeAndWait,
  followOpsEvents,
  submitOpsOperationWithRecovery,
  waitForOpsResult,
} from "../services/ops-client.js";

export function composeFileArgs(
  paths: Pick<RepoPaths, "composeOutPath" | "composeReleasePath"> = repoPaths(),
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const args = ["-f", paths.composeOutPath];
  if (fileExists(paths.composeReleasePath)) args.push("-f", paths.composeReleasePath);
  return args;
}

export interface PsEntry {
  service: string;
  state: "running" | "exited" | "restarting" | "created" | "paused" | "not-running";
}

interface OpsDependencies {
  client?: ApiOpsClient;
}

interface AsyncOpsDependencies extends OpsDependencies {
  operationKey?: string;
  signal?: AbortSignal;
}

let sharedClient: ApiOpsClient | undefined;

function client(dependencies: OpsDependencies): ApiOpsClient {
  if (dependencies.client) return dependencies.client;
  sharedClient ??= createApiOpsClient();
  return sharedClient;
}

function composeState(
  state: OpsResultFor<"stack.status">["services"][number]["state"],
): PsEntry["state"] {
  if (state === "stopped" || state === "unknown") return "not-running";
  return state;
}

export async function dockerStatus(
  dependencies: OpsDependencies = {},
): Promise<OpsResultFor<"docker.status">> {
  const submitted = await client(dependencies).execute({ kind: "docker.status" }, {});
  if (submitted.execution !== "sync") throw new ApiOpsError("runtime");
  return submitted.value;
}

export async function dockerComposePs(dependencies: OpsDependencies = {}): Promise<PsEntry[]> {
  try {
    const submitted = await client(dependencies).execute({ kind: "stack.status" }, {});
    if (submitted.execution !== "sync") return [];
    return submitted.value.services.map((service) => ({
      service: service.serviceId,
      state: composeState(service.state),
    }));
  } catch {
    return [];
  }
}

export async function inspectDawarichProvisioning(
  dependencies: OpsDependencies = {},
): Promise<OpsResultFor<"dawarich.provisioning.inspect"> | null> {
  try {
    const submitted = await client(dependencies).execute(
      { kind: "dawarich.provisioning.inspect" },
      {},
    );
    return submitted.execution === "sync" ? submitted.value : null;
  } catch {
    return null;
  }
}

export type DockerComposeAction =
  | "start"
  | "stop"
  | "restart"
  | "recreate"
  | "recreate-isolated"
  | "remove"
  | "pull";

export const STACK_STOP_GUIDANCE =
  "Stack shutdown is unavailable from the web API because it would stop the operations agent. Run the documented host shutdown command instead.";

function typedAction(serviceId: string, action: DockerComposeAction): OpsOperation | null {
  if (!serviceId) return action === "start" ? { kind: "stack.start" } : null;
  switch (action) {
    case "start":
      return { kind: "service.start", serviceId };
    case "stop":
      return { kind: "service.stop", serviceId };
    case "restart":
      return { kind: "service.restart", serviceId };
    case "recreate":
      return { kind: "service.recreate", serviceId };
    case "recreate-isolated":
      return { kind: "service.recreateIsolated", serviceId };
    case "remove":
      return { kind: "service.remove", serviceId };
    case "pull":
      return { kind: "service.pull", serviceId };
  }
}

export async function dockerComposeAction(
  serviceId: string,
  action: DockerComposeAction,
  options: AsyncOpsDependencies = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!serviceId && action === "stop") {
    return { exitCode: 1, stdout: "", stderr: STACK_STOP_GUIDANCE };
  }
  const operation = typedAction(serviceId, action);
  if (!operation || !options.operationKey) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "A durable operation identity is required for this request.",
    };
  }
  try {
    await executeAndWait(client(options), operation, options.operationKey, {
      signal: options.signal,
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (error) {
    const errorClass = error instanceof ApiOpsError ? error.errorClass : "runtime";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Operations request failed (${errorClass}).`,
    };
  }
}

export async function dockerComposeLogSnapshot(
  serviceId: string,
  tail: number,
  dependencies: OpsDependencies = {},
): Promise<OpsResultFor<"service.logs">> {
  const submitted = await client(dependencies).execute(
    { kind: "service.logs", serviceId, tail },
    {},
  );
  if (submitted.execution !== "sync") throw new ApiOpsError("runtime");
  return submitted.value;
}

export async function dockerComposeLogs(
  serviceId: string,
  out: ServerResponse,
  options: AsyncOpsDependencies & { tail: number; maxDurationSeconds?: number },
): Promise<void> {
  if (!options.operationKey) throw new ApiOpsError("validation");
  if (out.destroyed || out.writableEnded || options.signal?.aborted) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  out.once("close", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const opsClient = client(options);
    const submitted = await submitOpsOperationWithRecovery(
      opsClient,
      {
        kind: "service.logs.follow",
        serviceId,
        tail: options.tail,
        maxDurationSeconds: options.maxDurationSeconds ?? 900,
      },
      options.operationKey,
      { signal: controller.signal },
    );
    if (submitted.execution !== "async") throw new ApiOpsError("runtime");
    if (controller.signal.aborted || out.destroyed || out.writableEnded) {
      await opsClient
        .cancel(submitted.operationId, { signal: AbortSignal.timeout(2_000) })
        .catch(() => undefined);
      return;
    }
    await followOpsEvents(opsClient, submitted.operationId, {
      signal: controller.signal,
      onLog: (_stream, message) => {
        if (!out.destroyed) out.write(`${message}\n`);
      },
    });
    await waitForOpsResult(opsClient, "service.logs.follow", submitted, {
      signal: controller.signal,
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError") && !out.destroyed) {
      out.write("Operations log stream ended.\n");
    }
  } finally {
    out.off("close", abort);
    options.signal?.removeEventListener("abort", abort);
    if (!out.destroyed && !out.writableEnded) out.end();
  }
}
