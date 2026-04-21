import { assertValidBackupName, runOpenmapxCliJobCommand } from "./admin-cli";
import type { JobContext } from "./job-runner";

type DataOperation =
  | "download-osm"
  | "download-gtfs"
  | "download-style"
  | "update"
  | "convert-overpass"
  | "link"
  | "clean"
  | "generate-api-keys";

type BackupOperation = "create" | "restore" | "delete";
type BulkServiceAction = "start" | "stop" | "restart" | "recreate" | "build";

function nonEmptyString(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((id) => id.length > 0);
}

export async function handleDataOperationJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: DataOperation;
    region?: string;
    countries?: string;
    feedsFile?: string;
    failFast?: boolean;
    target?: string;
    repoUrl?: string;
    output?: string;
  };

  const op = payload.operation;
  if (!op) throw new Error("Missing data operation");

  const args: string[] = ["data"];
  switch (op) {
    case "download-osm": {
      args.push("download", "osm");
      const region = nonEmptyString(payload.region);
      if (region) args.push(region);
      break;
    }
    case "download-gtfs": {
      args.push("download", "gtfs");
      const countries = nonEmptyString(payload.countries);
      const feedsFile = nonEmptyString(payload.feedsFile);
      if (countries) args.push("--countries", countries);
      if (feedsFile) args.push("--feeds-file", feedsFile);
      break;
    }
    case "download-style": {
      args.push("download", "style");
      break;
    }
    case "update": {
      args.push("update");
      const region = nonEmptyString(payload.region);
      const countries = nonEmptyString(payload.countries);
      const feedsFile = nonEmptyString(payload.feedsFile);
      if (region) args.push(region);
      if (countries) args.push("--countries", countries);
      if (feedsFile) args.push("--feeds-file", feedsFile);
      if (payload.failFast === true) args.push("--fail-fast");
      break;
    }
    case "convert-overpass": {
      args.push("convert", "overpass");
      const region = nonEmptyString(payload.region);
      if (region) args.push(region);
      break;
    }
    case "link": {
      args.push("link");
      break;
    }
    case "clean": {
      const target = nonEmptyString(payload.target);
      if (!target) throw new Error("clean operation requires target");
      args.push("clean", target);
      break;
    }
    case "generate-api-keys": {
      args.push("generate-api-keys");
      const repoUrl = nonEmptyString(payload.repoUrl);
      const output = nonEmptyString(payload.output);
      if (repoUrl) args.push("--repo-url", repoUrl);
      if (output) args.push("--output", output);
      break;
    }
    default:
      throw new Error(`Unsupported data operation: ${String(op)}`);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { operation: op, args };
}

export async function handleBackupOperationJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: BackupOperation;
    name?: string;
    serviceIds?: string[];
    stopRunning?: boolean;
  };

  const op = payload.operation;
  if (!op) throw new Error("Missing backup operation");

  const args: string[] = ["backup"];
  switch (op) {
    case "create": {
      args.push("create");
      const name = nonEmptyString(payload.name);
      if (name) {
        assertValidBackupName(name);
        args.push("--name", name);
      }
      break;
    }
    case "restore": {
      const name = nonEmptyString(payload.name);
      if (!name) throw new Error("restore operation requires name");
      assertValidBackupName(name);
      args.push("restore", name);
      const serviceIds = toIdList(payload.serviceIds);
      if (serviceIds.length > 0) args.push("--services", ...serviceIds);
      if (payload.stopRunning === true) args.push("--stop-running");
      break;
    }
    case "delete": {
      const name = nonEmptyString(payload.name);
      if (!name) throw new Error("delete operation requires name");
      assertValidBackupName(name);
      args.push("delete", name);
      break;
    }
    default:
      throw new Error(`Unsupported backup operation: ${String(op)}`);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { operation: op, args };
}

export async function handleServiceBulkJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    action?: BulkServiceAction;
    serviceIds?: string[];
    all?: boolean;
    region?: string;
    continueOnError?: boolean;
  };

  const action = payload.action;
  if (!action) throw new Error("Missing bulk service action");
  const serviceIds = toIdList(payload.serviceIds);

  const args: string[] = ["services"];
  if (action === "build") {
    const region = nonEmptyString(payload.region);
    if (payload.all === true || serviceIds.length === 0) {
      args.push("build-all");
      if (region) args.push("--region", region);
      if (payload.continueOnError === false) args.push("--fail-fast");
    } else {
      args.push("build", ...serviceIds);
      if (region) args.push("--region", region);
      if (payload.continueOnError === true) args.push("--continue-on-error");
    }
  } else {
    if (serviceIds.length === 0) {
      throw new Error(`Bulk action "${action}" requires one or more services`);
    }
    args.push(action, ...serviceIds);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { action, args, serviceIds };
}
