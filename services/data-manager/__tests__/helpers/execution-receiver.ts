import type { DataExecutionStatus } from "@openmapx/core/data-manager-contracts";
import type { DataExecutionReceiver } from "../../src/jobs/execution/api.js";
/** Unit observer collaborator only. Real SQL/authority/HTTP acceptance uses the
 * owned fixtures under src/jobs/execution, never this adapter. */
export function dataReceipt(patch: Partial<DataExecutionStatus> = {}): DataExecutionStatus {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    operationKey: "opk1_unit_original_cron",
    fingerprint: "a".repeat(64),
    admittedAt: 1,
    deadlineAt: 4102444800000,
    kind: "overture-sync",
    status: "ok",
    publication: "committed",
    cancellationRequestedAt: null,
    progress: 1,
    diagnostics: { tail: [], truncated: false },
    ...patch,
  };
}
export function receiverFixture(patch: Partial<DataExecutionReceiver> = {}): DataExecutionReceiver {
  const unsupported = async (): Promise<never> => {
    throw Error("Unused unit receiver operation");
  };
  return {
    admitLocal: async () => dataReceipt(),
    admitMaintenance: unsupported,
    subscribe: () => () => {},
    legacyResult: () => undefined,
    admit: unsupported,
    admitHardlinks: unsupported,
    inspect: async () => dataReceipt(),
    lookup: unsupported,
    requestCancel: unsupported,
    prepareFence: unsupported,
    inspectFence: unsupported,
    settleFence: unsupported,
    ...patch,
  };
}
