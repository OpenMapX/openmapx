import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { repoPaths } from "@openmapx/core/server";
import { dockerComposeAction } from "../utils/docker-compose";
import { runOpenmapxCliJobCommand } from "./admin-cli";
import { applyHardlinksFromPlan, renderAndPersistCompose } from "./admin-ops";
import type { JobContext } from "./job-runner";
import { getServiceRegistry } from "./service-registry";
import { APP_API_RESTART_PHASE } from "./system-update-state";

const execFile = promisify(execFileCallback);

export const CORE_UPDATE_SERVICE_IDS = ["data-manager", "app-web", "app-api"] as const;

export interface CoreImageStatus {
  id: string;
  name: string;
  image: string | null;
  containerState: string;
  runningImageId: string | null;
  localImageId: string | null;
  updateAvailable: boolean;
  status: "up-to-date" | "update-available" | "not-running" | "unknown";
  error?: string;
}

type ExecDocker = (args: string[], timeoutMs?: number) => Promise<string>;

async function defaultExecDocker(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFile("docker", args, { timeout: timeoutMs, maxBuffer: 10_000_000 });
  return stdout ?? "";
}

function parseComposePs(raw: string): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>];
  } catch {
    // Older Compose releases emit one JSON object per line.
  }
  return trimmed
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stringField(row: Record<string, unknown> | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function inspectId(
  execDocker: ExecDocker,
  type: "container" | "image",
  target: string | null,
): Promise<string | null> {
  if (!target) return null;
  try {
    const format = type === "container" ? "{{.Image}}" : "{{.Id}}";
    const raw = await execDocker([type, "inspect", "--format", format, target]);
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compare each running core container with the image currently cached for its
 * configured tag. A check operation pulls tags first; this read itself never
 * contacts a registry or changes Docker state.
 */
export async function getCoreImageStatuses(
  execDocker: ExecDocker = defaultExecDocker,
): Promise<CoreImageStatus[]> {
  const composePath = repoPaths().composeOutPath;
  const registry = getServiceRegistry();
  const enabledCore = CORE_UPDATE_SERVICE_IDS.map((id) => registry.get(id)).filter(
    (service) => service?.enabled,
  );

  let composeConfig: { services?: Record<string, { image?: string }> } = {};
  let psRows: Array<Record<string, unknown>> = [];
  try {
    const [configRaw, psRaw] = await Promise.all([
      execDocker(["compose", "-f", composePath, "config", "--format", "json"]),
      execDocker(["compose", "-f", composePath, "ps", "-a", "--format", "json"]),
    ]);
    composeConfig = JSON.parse(configRaw) as typeof composeConfig;
    psRows = parseComposePs(psRaw);
  } catch (error) {
    return enabledCore.map((service) => ({
      id: service?.manifest.id ?? "unknown",
      name: service?.manifest.name ?? "Unknown service",
      image: null,
      containerState: "unknown",
      runningImageId: null,
      localImageId: null,
      updateAvailable: false,
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return Promise.all(
    enabledCore.map(async (service): Promise<CoreImageStatus> => {
      const id = service?.manifest.id ?? "unknown";
      const row = psRows.find((candidate) => stringField(candidate, "Service") === id);
      const container = stringField(row, "Name");
      const image = composeConfig.services?.[id]?.image ?? null;
      const [runningImageId, localImageId] = await Promise.all([
        inspectId(execDocker, "container", container),
        inspectId(execDocker, "image", image),
      ]);
      const containerState = stringField(row, "State") ?? "not-running";
      const updateAvailable = Boolean(
        runningImageId && localImageId && runningImageId !== localImageId,
      );
      const status = !runningImageId
        ? "not-running"
        : !localImageId
          ? "unknown"
          : updateAvailable
            ? "update-available"
            : "up-to-date";
      return {
        id,
        name: service?.manifest.name ?? id,
        image,
        containerState,
        runningImageId,
        localImageId,
        updateAvailable,
        status,
      };
    }),
  );
}

async function pullCoreImages(ctx: JobContext): Promise<void> {
  for (const id of CORE_UPDATE_SERVICE_IDS) {
    const service = getServiceRegistry().get(id);
    if (!service?.enabled) {
      await ctx.log(`Skipping disabled core service ${id}.`);
      continue;
    }
    await ctx.log(
      `Pulling ${id} (${service.manifest.container.image}:${service.manifest.container.tag})…`,
    );
    const result = await dockerComposeAction(id, "pull");
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-4).join("; ");
      throw new Error(`Failed to pull ${id}${detail ? `: ${detail}` : ""}`);
    }
  }
}

function preUpdateBackupName(now = new Date()): string {
  return `pre-update-${now.toISOString().replace(/[-:.]/g, "")}`;
}

export async function handleSystemUpdateJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as { operation?: "check" | "apply"; createBackup?: boolean };
  if (payload.operation === "check") {
    await ctx.setProgress(10);
    await pullCoreImages(ctx);
    await ctx.setProgress(90);
    const images = await getCoreImageStatuses();
    await ctx.log(
      images.some((image) => image.updateAvailable)
        ? "New core images are ready to apply."
        : "Core application images are up to date.",
    );
    return { operation: "check", images };
  }
  if (payload.operation !== "apply") throw new Error("Unsupported system update operation");

  if (payload.createBackup !== false) {
    const backupName = preUpdateBackupName();
    await ctx.log(`Creating safety backup ${backupName}…`);
    await runOpenmapxCliJobCommand(ctx, ["backup", "create", "--name", backupName]);
  } else {
    await ctx.log("Safety backup skipped by operator.", "stderr");
  }
  await ctx.setProgress(20);

  await ctx.log("Rendering the current service selection and applying data links…");
  await renderAndPersistCompose();
  await applyHardlinksFromPlan({ log: (message) => ctx.log(message) });
  await ctx.setProgress(30);

  // Pull all images before replacing anything. A registry failure therefore
  // leaves the currently-running application untouched.
  await pullCoreImages(ctx);
  await ctx.setProgress(55);

  // Dependencies are deliberately excluded so Compose cannot replace app-api
  // before the durable restart checkpoint below has been written.
  for (const id of ["data-manager", "app-web"] as const) {
    const service = getServiceRegistry().get(id);
    if (!service?.enabled) continue;
    await ctx.log(`Updating ${id}…`);
    const result = await dockerComposeAction(id, "recreate", { noDeps: true });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update ${id}: ${result.stderr.trim() || "docker compose failed"}`);
    }
  }
  await ctx.setProgress(85);

  const api = getServiceRegistry().get("app-api");
  if (!api?.enabled) {
    return { operation: "apply", phase: "complete", appApiRestarted: false };
  }

  await ctx.log("Updating app-api last. The admin connection will briefly reconnect…");
  await ctx.checkpoint({ phase: APP_API_RESTART_PHASE }, 95);
  const apiResult = await dockerComposeAction("app-api", "recreate", { noDeps: true });
  if (apiResult.exitCode !== 0) {
    throw new Error(
      `Failed to update app-api: ${apiResult.stderr.trim() || "docker compose failed"}`,
    );
  }
  return { operation: "apply", phase: "complete", appApiRestarted: true };
}

export async function handleSystemDiagnosticsJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await ctx.log("Running deep service and in-network probes…");
  await runOpenmapxCliJobCommand(ctx, ["check"]);
  return { operation: "diagnostics" };
}

export const _systemMaintenanceTestHelpers = { parseComposePs, preUpdateBackupName };
