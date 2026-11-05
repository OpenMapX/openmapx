import { randomUUID } from "node:crypto";
import { controlChildOperationKey, fixedDataBodyFingerprint } from "@openmapx/core/build-artifacts";
import {
  type DataExecutionInput,
  dataExecutionStatusSchema,
} from "@openmapx/core/data-manager-contracts";
import { type ExecutionRef, executionFingerprint } from "@openmapx/core/ops";
import { expect, it, vi } from "vitest";
import { type DataUpdateEffects, DataUpdateFailure, runDataUpdate } from "../src/lib/data-update";

const execution: ExecutionRef = {
  executor: "host-cli",
  principal: "host-cli",
  executionId: randomUUID(),
  operationKey: `opk1_${"a".repeat(43)}`,
  operationFingerprint: "a".repeat(64),
  fingerprint: "b".repeat(64),
  deadlineAt: Date.now() + 3600000,
};
const options = { region: "europe/germany", countries: ["DE"], failFast: false, execution };
function status(step: "osm" | "transit" | "fonts", input: DataExecutionInput) {
  const deadlineAt = execution.deadlineAt;
  return dataExecutionStatusSchema.parse({
    id: randomUUID(),
    operationKey: controlChildOperationKey(
      execution.operationKey,
      step,
      ["osm", "transit", "fonts"].indexOf(step),
    ),
    kind: input.kind,
    status: "ok",
    publication: "committed",
    admittedAt: Date.now(),
    deadlineAt,
    cancellationRequestedAt: null,
    progress: 1,
    diagnostics: { tail: [], truncated: false },
    result:
      input.kind === "download-osm"
        ? { kind: input.kind, region: "europe/germany", sizeBytes: 1 }
        : input.kind === "transit-sync"
          ? {
              kind: input.kind,
              finalStatus: "ok",
              sourceRevision: "pinned-catalog",
              countries: ["de"],
            }
          : { kind: "download-fonts", completed: true },
    fingerprint: executionFingerprint({
      kind: input.kind,
      operationFingerprint: fixedDataBodyFingerprint(input),
      deadlineAt,
      parent: {
        issuer: execution.executor,
        execution,
        operationKey: execution.operationKey,
        fingerprint: execution.fingerprint,
        deadlineAt: execution.deadlineAt,
      },
    }),
  });
}
function effects() {
  const e = {
    checkpoint: vi.fn<DataUpdateEffects["checkpoint"]>(async () => {}),
    checkpointAttempt: vi.fn<DataUpdateEffects["checkpointAttempt"]>(async () => {}),
    runDataStep: vi.fn(async (step: "osm" | "transit" | "fonts", input: DataExecutionInput) =>
      status(step, input),
    ),
    build: vi.fn<DataUpdateEffects["build"]>(async () => ({
      outcome: "success" as const,
      completedServiceIds: ["tileserver"],
      failedServiceIds: [],
      skippedServiceIds: [],
    })),
    prepare: vi.fn(async () => ({
      revisionId: `cfg1_${"r".repeat(43)}`,
      coordinatorMode: "ensure-running" as const,
      hardlinks: { applied: true, linked: 1, skipped: 0, pruned: 0, entries: 1 },
    })),
  };
  return e;
}
it("checkpoints and completes data -> graphs -> generation/hardlinks in order", async () => {
  const e = effects();
  const receipt = await runDataUpdate(options, e);
  expect(e.runDataStep.mock.calls.map(([step]) => step)).toEqual(["osm", "transit", "fonts"]);
  expect(e.runDataStep).toHaveBeenCalledBefore(e.build);
  expect(e.build).toHaveBeenCalledBefore(e.prepare);
  expect(e.build).toHaveBeenCalledWith({ region: options.region, continueOnError: true });
  expect(receipt).toMatchObject({
    phase: "complete",
    completedBuildIds: ["tileserver"],
    revisionId: `cfg1_${"r".repeat(43)}`,
  });
  expect(e.checkpoint.mock.calls.length).toBeGreaterThan(5);
});
it.each(["partial", "error", "interrupted", "canceled", "running"] as const)(
  "never builds after transit %s",
  async (outcome) => {
    const e = effects();
    e.runDataStep.mockImplementation(async (step, input) => ({
      ...status(step, input),
      status: step === "transit" ? outcome : "ok",
    }));
    await expect(runDataUpdate(options, e)).rejects.toBeInstanceOf(DataUpdateFailure);
    expect(e.build).not.toHaveBeenCalled();
    expect(e.prepare).not.toHaveBeenCalled();
    expect(e.runDataStep.mock.calls.map(([step]) => step)).toEqual(["osm", "transit"]);
  },
);
it.each(["key", "fingerprint", "deadline"])("rejects a foreign transit %s", async (field) => {
  const e = effects();
  e.runDataStep.mockImplementation(async (step, input) => {
    const s = status(step, input);
    return step !== "transit"
      ? s
      : {
          ...s,
          ...(field === "key"
            ? { operationKey: `opk1_${"z".repeat(43)}` }
            : field === "fingerprint"
              ? { fingerprint: "f".repeat(64) }
              : { deadlineAt: execution.deadlineAt + 1 }),
        };
  });
  await expect(runDataUpdate(options, e)).rejects.toBeInstanceOf(DataUpdateFailure);
  expect(e.build).not.toHaveBeenCalled();
});
it("retains a continued partial graph result after refreshing successful hardlinks", async () => {
  const e = effects();
  e.build.mockResolvedValue({
    outcome: "partial",
    completedServiceIds: ["tileserver"],
    failedServiceIds: ["valhalla"],
    skippedServiceIds: ["motis"],
  });
  const error = await runDataUpdate(options, e).catch((e) => e);
  expect(error).toBeInstanceOf(DataUpdateFailure);
  expect(error.receipt).toMatchObject({
    phase: "link",
    completedBuildIds: ["tileserver"],
    failedBuildIds: ["valhalla"],
    skippedBuildIds: ["motis"],
  });
  expect(e.prepare).toHaveBeenCalledOnce();
});
it("stops before another data admission if checkpoint persistence fails", async () => {
  const e = effects();
  e.checkpoint.mockImplementation(async (receipt) => {
    if ((receipt as { phase: string }).phase === "transit") throw Error("Disk failure");
  });
  await expect(runDataUpdate(options, e as DataUpdateEffects)).rejects.toBeInstanceOf(
    DataUpdateFailure,
  );
  expect(e.runDataStep.mock.calls.map(([step]) => step)).toEqual(["osm"]);
  expect(e.build).not.toHaveBeenCalled();
});
