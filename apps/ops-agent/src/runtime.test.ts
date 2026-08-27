import { OPS_OPERATION_KINDS } from "@openmapx/core/ops";
import { describe, expect, it } from "vitest";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";

const context = {
  signal: new AbortController().signal,
  emitLog: () => undefined,
  claim: {
    fingerprint: "f".repeat(64),
    operation: { kind: "docker.status" },
    source: "registry",
    capability: { revisionId: "registry-v1", values: {} },
  } as const,
};

describe("typed ops runtime registry", () => {
  it("has one fail-closed typed handler for every frozen operation kind", async () => {
    const runtime = createUnavailableRuntime();
    expect(Object.keys(runtime).sort()).toEqual([...OPS_OPERATION_KINDS].sort());
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "service.logs.follow", serviceId: "redis", tail: 10, maxDurationSeconds: 30 },
        context,
      ),
    ).rejects.toMatchObject({ name: "OpsNotWiredError" });
  });

  it("strictly rejects a handler result for a different operation kind", async () => {
    const runtime = createUnavailableRuntime();
    runtime["docker.status"] = async () => ({ changed: true }) as never;
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "docker.status" },
        {
          signal: new AbortController().signal,
          emitLog: () => undefined,
          claim: context.claim,
        },
      ),
    ).rejects.toThrow();
  });
});
