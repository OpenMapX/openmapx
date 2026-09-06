import { assertValidBackupName } from "./admin-cli";
import { executeAdminJobOperation } from "./admin-job-ops";
import { getAdminOperation, parseAdminOperationInput } from "./admin-operation-catalog";
import { assertKnownServiceIds, assertRegion } from "./admin-operation-input";
import type { JobContext } from "./job-runner";

type BackupOperation = "create" | "restore" | "delete";
type BulkServiceAction = "start" | "stop" | "restart" | "update" | "build";

/** Payload the operations route enqueues for `data.operation` jobs. */
export interface DataOperationJobPayload {
  operation: string;
  version: number;
  input: Record<string, unknown>;
}

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
  const payload = ctx.payload as Partial<DataOperationJobPayload>;
  const id = typeof payload.operation === "string" ? payload.operation : "";
  const definition = getAdminOperation(id);
  if (!definition) throw new Error(`Unsupported data operation: ${id || "(missing)"}`);
  if (payload.version !== definition.version) {
    throw new Error(
      `Data operation ${id} was queued for catalog version ${String(payload.version)}; current is ${definition.version}`,
    );
  }
  // The route validated this input already. Re-parsing here means a payload
  // that reached the table by any other path still cannot escape the schema.
  const parsed = parseAdminOperationInput(definition, payload.input);
  if (!parsed.ok) throw new Error(`Invalid input for data operation ${id}: ${parsed.error}`);

  const operation = definition.effect(parsed.input);
  const result: unknown = await executeAdminJobOperation(ctx, operation, `admin-job.data.${id}`);
  const resourceId =
    typeof result === "object" && result !== null && "resourceId" in result
      ? result.resourceId
      : undefined;
  return {
    operation: id,
    ...(typeof resourceId === "string" && resourceId ? { resourceId } : {}),
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
