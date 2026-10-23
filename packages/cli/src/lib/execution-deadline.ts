import { AsyncLocalStorage } from "node:async_hooks";
import type { DataManagerTransport } from "@openmapx/core/data-manager-sdk";
import { executionRefSchema, opsExecutionBudget } from "@openmapx/core/ops";
import { withCliControlContext } from "./control-context";

// Restriction only. These values authenticate no principal, parent, role or lease.
const deadlines = new AsyncLocalStorage<{ deadlineAt: number; signal: AbortSignal }>();
function localBudget(args: readonly string[]): number {
  const [group, action] = args;
  const kind =
    group === "services" && action === "build"
      ? "service.build"
      : group === "services" && action === "build-all"
        ? "services.buildAll"
        : group === "services" && action === "logs"
          ? "service.logs.follow"
          : group === "services" && action === "update"
            ? "system.update"
            : group === "data"
              ? "data.update"
              : group === "check"
                ? "system.diagnostics"
                : "backup.create";
  return opsExecutionBudget(kind).processMs;
}
export async function withCliExecutionDeadline<T>(
  args: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const encoded = process.env.OPENMAPX_CONTROL_EXECUTION;
  const inherited = process.env.OPENMAPX_CLI_DEADLINE_AT;
  if (
    (process.env.OPENMAPX_CONTROL_DELEGATION || process.env.OPENMAPX_PARENT_EXECUTION) &&
    encoded === undefined
  )
    throw Error("Missing bounded fixed CLI execution");

  if (encoded === undefined && inherited === undefined) return run();
  if (encoded !== undefined && Buffer.byteLength(encoded) > 2048)
    throw Error("Invalid execution deadline");
  const requested =
    encoded === undefined ? Infinity : executionRefSchema.parse(JSON.parse(encoded)).deadlineAt;
  if (
    inherited !== undefined &&
    (!/^\d{1,16}$/.test(inherited) || !Number.isSafeInteger(Number(inherited)))
  )
    throw Error("Invalid execution deadline");
  const deadlineAt = Math.min(
    requested,
    inherited === undefined ? Infinity : Number(inherited),
    Date.now() + localBudget(args),
    deadlines.getStore()?.deadlineAt ?? Infinity,
  );
  if (deadlineAt <= Date.now()) throw Error("Execution deadline elapsed");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Error("Execution deadline elapsed")),
    deadlineAt - Date.now(),
  );
  timer.unref();
  try {
    return await deadlines.run({ deadlineAt, signal: controller.signal }, () =>
      withCliControlContext(args, run),
    );
  } finally {
    clearTimeout(timer);
  }
}
export function assertCliExecutionAvailable(): void {
  const context = deadlines.getStore();
  if (context && (context.signal.aborted || Date.now() >= context.deadlineAt))
    throw Error("Execution deadline elapsed");
}
export function cliProcessOptions(phaseTimeoutMs?: number) {
  assertCliExecutionAvailable();
  const context = deadlines.getStore();
  if (!context) return phaseTimeoutMs === undefined ? {} : { timeout: phaseTimeoutMs };
  return {
    timeout: Math.max(1, Math.min(phaseTimeoutMs ?? Infinity, context.deadlineAt - Date.now())),
    cancelSignal: context.signal,
    forceKillAfterDelay: 2000,
    env: {
      OPENMAPX_CONTROL_EXECUTION: undefined,
      OPENMAPX_CONTROL_DELEGATION: undefined,
      OPENMAPX_PARENT_EXECUTION: undefined,
      OPENMAPX_CLI_DEADLINE_AT: String(context.deadlineAt),
    },
  };
}
export function cliAcquisitionOptions(): { signal?: AbortSignal; requestTimeoutMs?: number } {
  assertCliExecutionAvailable();
  const context = deadlines.getStore();
  return context
    ? { signal: context.signal, requestTimeoutMs: Math.min(15000, context.deadlineAt - Date.now()) }
    : {};
}
/** Remote mutations need a receiver-retained deadline. Unsigned CLI metadata cannot supply it. */
export function constrainCliDataManagerTransport(
  transport: DataManagerTransport,
): DataManagerTransport {
  return {
    request(operationId, url, options) {
      assertCliExecutionAvailable();
      if (
        deadlines.getStore() &&
        !["GET", "HEAD"].includes((options?.method ?? "GET").toUpperCase())
      )
        throw Error("Managed data-manager execution requires a deadline-aware receiver upgrade");
      return transport.request(operationId, url, options);
    },
  };
}
export function assertCliRemoteMutationSupported(): void {
  assertCliExecutionAvailable();
  if (deadlines.getStore())
    throw Error("Managed data-manager execution requires a deadline-aware receiver upgrade");
}
