import { TargetBusyError } from "@openmapx/core/build-artifacts";
import type { DataExecutionStatus } from "@openmapx/core/data-manager-contracts";
import { createControlRootOperationKey, OpsClientError } from "@openmapx/core/ops";
import { describe, expect, it } from "vitest";
import { resolveOperationsProfile } from "../transitous/operations-profile";
import { createDataExecutionReceiver } from "./receiver";
import type { DataExecutionRuntime } from "./runtime";

const deadline = Date.now() + 60_000;
const request = {
  operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: Buffer.alloc(16, 7) }),
  requestedDeadlineAt: deadline,
  revisionId: `cfg1_${"r".repeat(43)}`,
  plan: [
    {
      source: "data/osm",
      target: "data/valhalla/osm-pbf",
      consumerService: "valhalla",
      dataType: "osm-pbf",
    },
  ],
  prune: true,
};
function status(patch: Partial<DataExecutionStatus>): DataExecutionStatus {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    operationKey: request.operationKey,
    fingerprint: "f".repeat(64),
    admittedAt: Date.now(),
    deadlineAt: deadline,
    kind: "generation-link",
    status: "queued",
    cancellationRequestedAt: null,
    progress: null,
    diagnostics: { tail: [], truncated: false },
    publication: "not_started",
    ...patch,
  };
}
/** A runtime whose lease acquisition is refused with `refusal` before any work. */
function refusingRuntime(refusal: unknown): DataExecutionRuntime {
  let refused = false;
  return {
    async admit(_input, options) {
      options.refused?.(refusal);
      refused = true;
      return status({});
    },
    settled: async () => {},
    inspect: async () =>
      refused
        ? status({
            status: "failed",
            diagnostics: {
              tail: [{ stream: "stderr", message: String((refusal as Error).message) }],
              truncated: false,
            },
          })
        : null,
    lookup: async () => null,
    requestCancel: async () => status({}),
    reconcile: async () => {},
    close: async () => {},
  };
}
function receiver(runtime: DataExecutionRuntime) {
  return createDataExecutionReceiver({
    runtime,
    installation: {} as never,
    configurationFence: {} as never,
    dispatcher: {} as never,
    operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
  });
}

describe("/link outcomes before any link", () => {
  it("answers busy when another holder has data-manager", async () => {
    await expect(
      receiver(
        refusingRuntime(
          new TargetBusyError("data-manager", {
            leaseId: "00000000-0000-4000-8000-000000000003",
            owner: { executor: "host-cli", operationKey: request.operationKey } as never,
            ownerKind: "control.rollback",
            state: "held",
          }),
        ),
      ).link(request, "host-cli"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("answers unavailable, not busy, when the agent did not answer the lease request", async () => {
    await expect(
      receiver(refusingRuntime(new OpsClientError("timeout"))).link(request, "host-cli"),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses a lease id from the API's token before admitting anything", async () => {
    let admitted = false;
    const runtime = refusingRuntime(undefined);
    runtime.admit = async () => {
      admitted = true;
      return status({});
    };
    await expect(
      receiver(runtime).link(
        { ...request, leaseId: "00000000-0000-4000-8000-000000000002" },
        "api",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(admitted).toBe(false);
  });
});
