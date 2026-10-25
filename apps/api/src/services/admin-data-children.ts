/** Finite existing single-data command descendants. Addresses come from the
 * retained agent root, including before a CLI/DM admission response exists. */

import { controlChildOperationKey, isFixedSingleDataCommand } from "@openmapx/core/build-artifacts";
import {
  dataExecutionIdentitySchema,
  dataExecutionStatusSchema,
  isDataExecutionTerminal,
} from "@openmapx/core/data-manager-contracts";
import {
  createDataManagerTransport,
  getDataExecution,
  requestDataExecutionCancellation,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import { eq } from "drizzle-orm";
import z from "zod/v4";
import { db } from "../db";
import { dataManagerJobs } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import type { JobContext } from "./job-runner";

const childSchema = z.strictObject({
  ...dataExecutionIdentitySchema.shape,
  parentAgentOperationKey: dataExecutionIdentitySchema.shape.operationKey,
  kind: dataExecutionStatusSchema.shape.kind,
  admittedAt: dataExecutionStatusSchema.shape.admittedAt,
  deadlineAt: dataExecutionStatusSchema.shape.deadlineAt,
  cancellationRequestedAt: z.iso.datetime().nullable(),
  state: z.enum(["observing", "terminal"]),
  status: dataExecutionStatusSchema.shape.status,
  publication: dataExecutionStatusSchema.shape.publication,
});
const childrenSchema = z
  .array(childSchema)
  .max(32)
  .refine(
    (children) =>
      Buffer.byteLength(JSON.stringify(children)) <= 128 * 1024 &&
      new Set(children.map((child) => child.operationKey)).size === children.length,
  );
export type DataChildrenCancellation =
  | "none"
  | "succeeded"
  | "contained"
  | "already_terminal"
  | "pending";
export async function cancelAdminDataChildren(
  result: unknown,
  roots: readonly { kind: string; operationKey: string }[],
  options: {
    context?: JobContext;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
  } = {},
): Promise<DataChildrenCancellation> {
  const known = childrenSchema.safeParse(
    (result as { _dataExecutions?: unknown } | null)?._dataExecutions ?? [],
  );
  if (!known.success) throw new JobObservationPending("invalid_identity");
  const children = known.data;
  const candidates = roots.filter((root) => isFixedSingleDataCommand(root.kind));
  if (!children.length && !candidates.length) return "none";
  if (!options.context) return "pending";
  const persist = async () => {
    await options.context!.checkpoint({
      ...options.context!.checkpointResult,
      _dataExecutions: children,
    });
  };
  // Actual DM rows can outlive both its CLI and the API observer. The verified
  // DM receiver wrote this parent binding; an absent row remains unknown to its
  // agent-root reconciliation and never authorizes another POST.
  for (const root of candidates) {
    const cliKey = controlChildOperationKey(root.operationKey, "data-workflow", 0),
      key = controlChildOperationKey(cliKey, "data-step", 0);
    const rows = await db
      .select()
      .from(dataManagerJobs)
      .where(eq(dataManagerJobs.operationKey, key))
      .limit(2);
    if (rows.length > 1) throw new JobObservationPending("invalid_identity");
    const row = rows[0];
    if (!row) continue;
    const parent = z
      .object({
        issuer: z.literal("host-cli"),
        execution: z.object({ executor: z.literal("host-cli"), operationKey: z.literal(cliKey) }),
      })
      .safeParse(row.executionParent);
    if (row.executionVersion !== 2 || !parent.success)
      throw new JobObservationPending("invalid_identity");
    const state = dataExecutionStatusSchema.parse({
      id: String(row.id),
      kind: row.kind,
      status: row.status,
      operationKey: row.operationKey,
      fingerprint: row.executionFingerprint,
      admittedAt: Number(row.admittedAt),
      deadlineAt: Number(row.deadlineAt),
      ...z
        .object({
          cancellationRequestedAt: z.string().nullable(),
          progress: z.number().nullable(),
          diagnostics: z.unknown(),
          publication: z.string(),
          result: z.unknown().optional(),
        })
        .parse(row.executionState),
    });
    const child = childSchema.parse({
        id: state.id,
        operationKey: key,
        fingerprint: state.fingerprint,
        parentAgentOperationKey: root.operationKey,
        kind: state.kind,
        admittedAt: state.admittedAt,
        deadlineAt: state.deadlineAt,
        cancellationRequestedAt: null,
        state: isDataExecutionTerminal(state) ? "terminal" : "observing",
        status: state.status,
        publication: state.publication,
      }),
      old = children.find((item) => item.operationKey === key);
    if (old) {
      if (
        old.id !== child.id ||
        old.fingerprint !== child.fingerprint ||
        old.kind !== child.kind ||
        old.admittedAt !== child.admittedAt ||
        old.deadlineAt !== child.deadlineAt ||
        old.parentAgentOperationKey !== root.operationKey
      )
        throw new JobObservationPending("invalid_identity");
    } else children.push(child);
  }
  childrenSchema.parse(children);
  if (!children.length) return "none";
  await persist();
  const transport = createDataManagerTransport({
    baseUrl: envString("DATA_MANAGER_URL", "http://localhost:4000"),
    authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
    requestTimeoutMs: 2000,
  });
  const outcomes: DataChildrenCancellation[] = [];
  let unresolved = false;
  const readSignal = () =>
      options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
    sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const child of children) {
    const match = (value: unknown) => {
      const status = dataExecutionStatusSchema.parse(value);
      if (
        status.id !== child.id ||
        status.operationKey !== child.operationKey ||
        status.fingerprint !== child.fingerprint ||
        status.kind !== child.kind ||
        status.admittedAt !== child.admittedAt ||
        status.deadlineAt !== child.deadlineAt
      )
        throw new JobObservationPending("invalid_identity");
      return status;
    };
    let status: ReturnType<typeof dataExecutionStatusSchema.parse>;
    try {
      status = match(
        unwrapDataManagerResponse(
          await getDataExecution(child.id, { transport, signal: readSignal() }),
        ),
      );
    } catch {
      unresolved = true;
      continue;
    }
    if (!isDataExecutionTerminal(status)) {
      child.cancellationRequestedAt ??= new Date().toISOString();
      await persist();
      try {
        status = match(
          await requestDataExecutionCancellation(
            { id: child.id, operationKey: child.operationKey, fingerprint: child.fingerprint },
            { transport, signal: readSignal() },
          ),
        );
      } catch {
        /* Receiver may have persisted intent; exact GET observation follows. */
      }
      for (let attempt = 0; attempt < 8 && !isDataExecutionTerminal(status); attempt++) {
        await sleep(options.pollIntervalMs ?? 250);
        try {
          status = match(
            unwrapDataManagerResponse(
              await getDataExecution(child.id, { transport, signal: readSignal() }),
            ),
          );
        } catch {
          unresolved = true;
          break;
        }
      }
    }
    if (!isDataExecutionTerminal(status)) {
      unresolved = true;
      continue;
    }
    Object.assign(child, {
      state: "terminal",
      status: status.status,
      publication: status.publication,
    });
    await persist();
    outcomes.push(
      status.status === "ok"
        ? "succeeded"
        : status.status === "canceled"
          ? "contained"
          : "already_terminal",
    );
  }
  if (unresolved) return "pending";
  return outcomes.includes("contained")
    ? "contained"
    : outcomes.every((outcome) => outcome === "succeeded")
      ? "succeeded"
      : "already_terminal";
}
