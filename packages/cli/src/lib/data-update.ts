import { controlChildOperationKey, fixedDataBodyFingerprint } from "@openmapx/core/build-artifacts";
import {
  type DataChildAttempt,
  type DataExecutionInput,
  type DataExecutionStatus,
  dataExecutionStatusSchema,
  normalizeDataExecutionInput,
  ordinaryDataExecutionInputSchema,
} from "@openmapx/core/data-manager-contracts";
import {
  type DataWorkflowReceipt,
  dataWorkflowReceiptSchema,
  type ExecutionRef,
  executionFingerprint,
  type ServiceBatchResult,
  type ServicePreparationResult,
  serviceBatchResultSchema,
} from "@openmapx/core/ops";

type DataStep = "osm" | "transit" | "fonts";
export interface DataUpdateOptions {
  region: string;
  countries: string[];
  failFast: boolean;
  execution: ExecutionRef;
  signal?: AbortSignal;
  stage?: "data" | "finalize";
  initialReceipt?: DataWorkflowReceipt;
}
export interface DataUpdateEffects {
  checkpoint(receipt: DataWorkflowReceipt): Promise<void>;
  checkpointAttempt(attempt: DataChildAttempt): Promise<void>;
  /** The installed adapter journals original admission intent before its first POST. */
  runDataStep(step: DataStep, input: DataExecutionInput): Promise<DataExecutionStatus>;
  build(options: { region: string; continueOnError: boolean }): Promise<ServiceBatchResult>;
  prepare(options: { coordinatorMode: "ensure-running" }): Promise<ServicePreparationResult>;
}
export class DataUpdateFailure extends Error {
  readonly receipt: DataWorkflowReceipt;
  constructor(receipt: DataWorkflowReceipt, cause: unknown) {
    super("Full Update did not complete", { cause });
    this.name = "DataUpdateFailure";
    this.receipt = dataWorkflowReceiptSchema.parse(receipt);
  }
}
function forward(options: DataUpdateOptions) {
  options.signal?.throwIfAborted();
  if (Date.now() >= options.execution.deadlineAt) throw Error("Full Update deadline elapsed");
}
function checkedChild(
  options: DataUpdateOptions,
  step: DataStep,
  input: DataExecutionInput,
  value: DataExecutionStatus,
) {
  const status = dataExecutionStatusSchema.parse(value);
  const parent = options.execution;
  if (
    status.kind !== input.kind ||
    status.operationKey !==
      controlChildOperationKey(
        parent.operationKey,
        step,
        ["osm", "transit", "fonts"].indexOf(step),
      ) ||
    status.deadlineAt > parent.deadlineAt ||
    status.fingerprint !==
      executionFingerprint({
        kind: input.kind,
        operationFingerprint: fixedDataBodyFingerprint(input),
        deadlineAt: status.deadlineAt,
        parent: {
          issuer: parent.executor,
          execution: parent,
          operationKey: parent.operationKey,
          fingerprint: parent.fingerprint,
          deadlineAt: parent.deadlineAt,
        },
      })
  )
    throw Error("Full Update child identity changed");
  return status;
}
/** Pure sequencing; operation authority and signed terminal verification belong to its installed effects. */
export async function runDataUpdate(
  options: DataUpdateOptions,
  effects: DataUpdateEffects,
): Promise<DataWorkflowReceipt> {
  const receipt: DataWorkflowReceipt = options.initialReceipt
    ? dataWorkflowReceiptSchema.parse(options.initialReceipt)
    : {
        version: 1,
        phase: "osm",
        children: [],
        completedBuildIds: [],
        failedBuildIds: [],
        skippedBuildIds: [],
      };
  const save = async () => {
    forward(options);
    await effects.checkpoint(dataWorkflowReceiptSchema.parse(receipt));
    forward(options);
  };
  try {
    const steps: [DataStep, DataExecutionInput][] = [
      ["osm", { kind: "download-osm", region: options.region }],
      ["transit", { kind: "transit-sync", countries: options.countries }],
      ["fonts", { kind: "download-fonts" }],
    ];
    if (
      options.stage === "finalize" &&
      (receipt.phase !== "build" ||
        receipt.children.length !== 3 ||
        receipt.children.some((c) => c.status !== "succeeded"))
    )
      throw Error("Full Update data phase is incomplete");
    for (const [step, raw] of options.stage === "finalize" ? [] : steps) {
      receipt.phase = step;
      await save();
      const input = ordinaryDataExecutionInputSchema.parse(normalizeDataExecutionInput(raw));
      const status = checkedChild(options, step, input, await effects.runDataStep(step, input));
      receipt.children.push({
        step,
        jobId: status.id,
        operationKey: status.operationKey,
        fingerprint: status.fingerprint,
        deadlineAt: status.deadlineAt,
        status:
          status.status === "ok"
            ? "succeeded"
            : status.status === "error" || status.status === "partial"
              ? "failed"
              : status.status,
      });
      await save();
      if (status.status !== "ok" || status.publication !== "committed" || !status.result)
        throw Error(`Prerequisite ${step} did not complete`);
      if (
        input.kind === "download-osm" &&
        (status.result.kind !== "download-osm" || status.result.region !== input.region)
      )
        throw Error("OSM region changed");
      if (
        input.kind === "transit-sync" &&
        (status.result.kind !== "transit-sync" ||
          status.result.finalStatus !== "ok" ||
          JSON.stringify([...status.result.countries].sort()) !== JSON.stringify(input.countries))
      )
        throw Error("Transit country selection changed");
    }
    receipt.phase = "build";
    await save();
    if (options.stage === "data") return dataWorkflowReceiptSchema.parse(receipt);
    const batch = serviceBatchResultSchema.parse(
      await effects.build({ region: options.region, continueOnError: !options.failFast }),
    );
    receipt.completedBuildIds = [...batch.completedServiceIds];
    receipt.failedBuildIds = [...batch.failedServiceIds];
    receipt.skippedBuildIds = [...batch.skippedServiceIds];
    await save();
    if (options.failFast && batch.outcome !== "success") throw Error("Graph build failed");
    receipt.phase = "link";
    await save();
    const prepared = await effects.prepare({ coordinatorMode: "ensure-running" });
    receipt.revisionId = prepared.revisionId;
    await save();
    if (batch.outcome !== "success") throw Error("Some graph builds failed");
    receipt.phase = "complete";
    await save();
    return dataWorkflowReceiptSchema.parse(receipt);
  } catch (error) {
    throw new DataUpdateFailure(receipt, error);
  }
}
