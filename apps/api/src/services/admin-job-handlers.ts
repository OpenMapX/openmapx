import { isAbsolute, relative, resolve } from "node:path";
import { findRepoRoot } from "@openmapx/core/server";
import { assertValidBackupName } from "./admin-cli";
import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import { getServiceRegistry } from "./service-registry";

type DataOperation =
  | "download-osm"
  | "download-fonts"
  | "update"
  | "convert-overpass"
  | "link"
  | "clean"
  | "generate-api-keys"
  | "overture-sync"
  | "overture-conflate"
  | "search-index-build";

type BackupOperation = "create" | "restore" | "delete";
type BulkServiceAction = "start" | "stop" | "restart" | "update" | "build";

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

// Input-shape guards run before values become typed operation identifiers.

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const REGION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_/.-]*$/;
// Used for `--countries` (comma-separated ISO-3166 alpha-2/3 codes).
const COUNTRIES_RE = /^[a-zA-Z]{2,3}(,[a-zA-Z]{2,3})*$/;

function rejectFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} must not begin with "-"`);
  }
}

function assertSlug(value: string, label: string): void {
  rejectFlagLike(value, label);
  if (!SLUG_RE.test(value)) {
    throw new Error(`${label} must be a slug (alphanumeric, ".", "_", "-")`);
  }
}

function assertRegion(value: string): void {
  rejectFlagLike(value, "region");
  if (value.includes("..") || !REGION_RE.test(value)) {
    throw new Error('region must match /^[A-Za-z0-9][A-Za-z0-9_/.-]*$/ and contain no ".."');
  }
}

function assertCountries(value: string): void {
  rejectFlagLike(value, "countries");
  if (!COUNTRIES_RE.test(value)) {
    throw new Error("countries must be a comma-separated list of ISO country codes");
  }
}

/** Throws unless `path` is absolute (or resolves to) inside the repo root. */
function assertInsideRepo(path: string, label: string): string {
  rejectFlagLike(path, label);
  const root = findRepoRoot();
  const resolved = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must resolve to a path inside the repo root`);
  }
  return resolved;
}

/** Validates each id in `serviceIds` exists in the registry. Throws on first miss. */
function assertKnownServiceIds(serviceIds: string[]): void {
  if (serviceIds.length === 0) return;
  let registry: ReturnType<typeof getServiceRegistry>;
  try {
    registry = getServiceRegistry();
  } catch {
    // Registry not initialized (cold start) — fall back to slug-shape check
    // only. This is the same posture the admin route takes.
    for (const id of serviceIds) assertSlug(id, "serviceId");
    return;
  }
  const known = new Set(registry.list().map((s) => s.manifest.id));
  for (const id of serviceIds) {
    assertSlug(id, "serviceId");
    if (!known.has(id)) {
      throw new Error(`Unknown serviceId: "${id}"`);
    }
  }
}

export async function handleDataOperationJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: DataOperation;
    region?: string;
    countries?: string;
    failFast?: boolean;
    target?: string;
    repoUrl?: string;
    output?: string;
    restart?: boolean;
  };

  const op = payload.operation;
  if (!op) throw new Error("Missing data operation");

  let operation:
    | { kind: "data.downloadOsm"; regionId?: string }
    | { kind: "data.downloadFonts" }
    | {
        kind: "data.update";
        regionId?: string;
        countryCodes?: string[];
        failFast?: boolean;
      }
    | { kind: "data.convertOverpass"; regionId?: string }
    | { kind: "data.link" }
    | { kind: "data.clean"; dataTypeId: string }
    | { kind: "data.generateApiKeys"; catalogRevisionId: string }
    | { kind: "data.overtureSync"; regionId: string }
    | { kind: "data.overtureConflate"; regionId: string; restart?: boolean }
    | { kind: "data.searchIndexBuild"; regionId: string };
  switch (op) {
    case "download-osm": {
      const region = nonEmptyString(payload.region);
      if (region) assertRegion(region);
      operation = { kind: "data.downloadOsm", ...(region ? { regionId: region } : {}) };
      break;
    }
    case "download-fonts": {
      operation = { kind: "data.downloadFonts" };
      break;
    }
    case "update": {
      const region = nonEmptyString(payload.region);
      const countries = nonEmptyString(payload.countries);
      if (region) assertRegion(region);
      if (countries) assertCountries(countries);
      operation = {
        kind: "data.update",
        ...(region ? { regionId: region } : {}),
        ...(countries ? { countryCodes: countries.toUpperCase().split(",") } : {}),
        ...(payload.failFast === true ? { failFast: true } : {}),
      };
      break;
    }
    case "convert-overpass": {
      const region = nonEmptyString(payload.region);
      if (region) assertRegion(region);
      operation = { kind: "data.convertOverpass", ...(region ? { regionId: region } : {}) };
      break;
    }
    case "link": {
      operation = { kind: "data.link" };
      break;
    }
    case "clean": {
      const target = nonEmptyString(payload.target);
      if (!target) throw new Error("clean operation requires target");
      assertSlug(target, "target");
      operation = { kind: "data.clean", dataTypeId: target };
      break;
    }
    case "generate-api-keys": {
      operation = {
        kind: "data.generateApiKeys",
        catalogRevisionId: "transitous-fixed-v1",
      };
      break;
    }
    case "overture-sync": {
      const region = nonEmptyString(payload.region);
      if (!region) throw new Error("overture-sync requires region");
      assertRegion(region);
      operation = { kind: "data.overtureSync", regionId: region };
      break;
    }
    case "overture-conflate": {
      const region = nonEmptyString(payload.region);
      if (!region) throw new Error("overture-conflate requires region");
      assertRegion(region);
      operation = {
        kind: "data.overtureConflate",
        regionId: region,
        ...(payload.restart === true ? { restart: true } : {}),
      };
      break;
    }
    case "search-index-build": {
      const region = nonEmptyString(payload.region);
      if (!region) throw new Error("search-index-build requires region");
      assertRegion(region);
      operation = { kind: "data.searchIndexBuild", regionId: region };
      break;
    }
    default:
      throw new Error(`Unsupported data operation: ${String(op)}`);
  }

  const result = await executeAdminJobOperation(ctx, operation, `admin-job.data.${op}`);
  return {
    operation: op,
    ...(result.resourceId ? { resourceId: result.resourceId } : {}),
  };
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

  switch (op) {
    case "create": {
      const backupId = nonEmptyString(payload.name) ?? `job-${ctx.jobId}`;
      assertValidBackupName(backupId);
      const result = await executeAdminJobOperation(
        ctx,
        { kind: "backup.create", backupId },
        "admin-job.backup.create",
      );
      return { operation: op, backupId: result.backupId };
    }
    case "restore": {
      const backupId = nonEmptyString(payload.name);
      if (!backupId) throw new Error("restore operation requires name");
      assertValidBackupName(backupId);
      const serviceIds = toIdList(payload.serviceIds);
      if (serviceIds.length > 0) assertKnownServiceIds(serviceIds);
      const result = await executeAdminJobOperation(
        ctx,
        {
          kind: "backup.restore",
          backupId,
          ...(serviceIds.length > 0 ? { serviceIds } : {}),
          ...(payload.stopRunning === true ? { stopRunning: true } : {}),
        },
        "admin-job.backup.restore",
      );
      return { operation: op, backupId: result.backupId };
    }
    case "delete": {
      const backupId = nonEmptyString(payload.name);
      if (!backupId) throw new Error("delete operation requires name");
      assertValidBackupName(backupId);
      const result = await executeAdminJobOperation(
        ctx,
        { kind: "backup.delete", backupId },
        "admin-job.backup.delete",
      );
      return { operation: op, backupId: result.backupId };
    }
    default:
      throw new Error(`Unsupported backup operation: ${String(op)}`);
  }
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
  assertKnownServiceIds(serviceIds);

  if (action === "build") {
    const region = nonEmptyString(payload.region);
    if (region) assertRegion(region);
    if (payload.all === true || serviceIds.length === 0) {
      const result = await executeAdminJobOperation(
        ctx,
        {
          kind: "services.buildAll",
          ...(region ? { regionId: region } : {}),
          ...(payload.continueOnError === false ? { failFast: true } : {}),
        },
        "admin-job.services.build-all",
      );
      return {
        action,
        completedServiceIds: result.completedServiceIds,
        failedServiceIds: result.failedServiceIds,
      };
    } else {
      const completedServiceIds: string[] = [];
      const failedServiceIds: string[] = [];
      for (const [index, serviceId] of serviceIds.entries()) {
        try {
          await executeAdminJobOperation(
            ctx,
            {
              kind: "service.build",
              serviceId,
              ...(region ? { regionId: region } : {}),
            },
            "admin-job.service.build",
            { durableIdentity: serviceId },
          );
          completedServiceIds.push(serviceId);
        } catch (error) {
          failedServiceIds.push(serviceId);
          if (payload.continueOnError !== true) throw error;
          await ctx.log(`Build failed for ${serviceId}`, "stderr");
        }
        await ctx.setProgress(Math.round(((index + 1) / serviceIds.length) * 100));
      }
      return { action, completedServiceIds, failedServiceIds };
    }
  } else {
    if (serviceIds.length === 0) {
      throw new Error(`Bulk action "${action}" requires one or more services`);
    }
    const completedServiceIds: string[] = [];
    const kind = `service.${action}` as
      | "service.start"
      | "service.stop"
      | "service.restart"
      | "service.update";
    for (const [index, serviceId] of serviceIds.entries()) {
      await executeAdminJobOperation(ctx, { kind, serviceId }, `admin-job.service.${action}`, {
        durableIdentity: serviceId,
      });
      completedServiceIds.push(serviceId);
      await ctx.setProgress(Math.round(((index + 1) / serviceIds.length) * 100));
    }
    return { action, completedServiceIds, failedServiceIds: [] };
  }
}

// Re-exported for tests. Keep the surface minimal — test-only helpers should
// not be imported by route handlers.
export const _argvGuards = {
  assertSlug,
  assertRegion,
  assertCountries,
  assertInsideRepo,
  assertKnownServiceIds,
  rejectFlagLike,
};
