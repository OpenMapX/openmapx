import { randomBytes } from "node:crypto";
import {
  type ControlInstallation,
  controlHeaders,
  inspectDataExecutionAdmission,
} from "@openmapx/core/build-artifacts";
import {
  normalizeDataExecutionInput,
  startGenerationHardlinksExecutionSchema,
} from "@openmapx/core/data-manager-contracts";
import { createControlRootOperationKey, opsExecutionBudget } from "@openmapx/core/ops";
import type { MotisOperationsPolicy } from "../transitous/operations-profile.js";
import type { DataExecutionReceiver } from "./api.js";
import type { DataConfigurationMaintenance } from "./configuration-maintenance.js";
import type { createDataExecutionDispatcher } from "./dispatch.js";
import { transitChildCandidateId } from "./ops-children.js";
import type { DataExecutionRuntime } from "./runtime.js";
import { dataExecutionInputFingerprint } from "./store.js";
export function createDataExecutionReceiver(deps: {
  runtime: DataExecutionRuntime;
  installation: ControlInstallation;
  configurationFence: DataConfigurationMaintenance;
  dispatcher: ReturnType<typeof createDataExecutionDispatcher>;
  operationsPolicy: MotisOperationsPolicy;
}): DataExecutionReceiver {
  const { runtime, installation, configurationFence } = deps;
  const validate = (value: Parameters<DataExecutionRuntime["admit"]>[0]) => {
    const input = normalizeDataExecutionInput(value);
    if (
      input.kind === "transit-sync" &&
      deps.operationsPolicy.profile !== "planet" &&
      (input.countries.length === 0 ||
        input.countries.some((country) => !deps.operationsPolicy.countries.includes(country)))
    )
      throw Object.assign(Error("Countries outside configured operations profile"), {
        statusCode: 422,
      });
    return input;
  };
  return {
    async admit(value, options) {
      const input = validate(value);
      if (input.kind === "generation-hardlinks" || input.kind === "transit-maintenance")
        throw Object.assign(Error("Service-internal data input"), { statusCode: 403 });
      const verified = inspectDataExecutionAdmission(installation, {
        ...options,
        input,
        operationFingerprint: dataExecutionInputFingerprint(input),
      });
      return runtime.admit(input, {
        operationKey: options.operationKey,
        requestedDeadlineAt: options.requestedDeadlineAt,
        ...(verified
          ? {
              parent: verified.parent,
              id: verified.execution.executionId,
              principal: verified.execution.principal,
              adopt: verified.adopt,
            }
          : {}),
      });
    },
    async admitHardlinks(value, rawHeaders) {
      const request = startGenerationHardlinksExecutionSchema.parse(value),
        verified = inspectDataExecutionAdmission(installation, {
          ...request,
          rawHeaders,
          operationFingerprint: dataExecutionInputFingerprint(request.input),
        });
      if (!verified || !controlHeaders(rawHeaders).delegation)
        throw Object.assign(Error("Signed borrowed generation leaf required"), { statusCode: 403 });
      const preparedGeneration = await configurationFence.assertGenerationAdmission(
        request,
        rawHeaders,
        verified.parent,
      );
      return runtime.admit(request.input, {
        ...(preparedGeneration ? { preparedGeneration } : {}),
        operationKey: request.operationKey,
        requestedDeadlineAt: request.requestedDeadlineAt,
        parent: verified.parent,
        id: verified.execution.executionId,
        principal: verified.execution.principal,
        adopt: verified.adopt,
        hardlinkPlan: request.plan,
      });
    },
    async admitLocal(value, source) {
      const input = validate(value),
        requestedDeadlineAt = Date.now() + opsExecutionBudget(input.kind).processMs,
        operationKey = createControlRootOperationKey({
          notAfter: requestedDeadlineAt,
          nonce: randomBytes(16),
        });
      return runtime.admit(input, { operationKey, requestedDeadlineAt, ...source });
    },
    async admitMaintenance(action, options) {
      const requestedDeadlineAt = Date.now() + 120000,
        operationKey = createControlRootOperationKey({
          notAfter: requestedDeadlineAt,
          nonce: randomBytes(16),
        });
      const input =
        action === "restart-primary"
          ? { kind: "transit-maintenance" as const, action }
          : {
              kind: "transit-maintenance" as const,
              action,
              candidateId: transitChildCandidateId({ operationKey }, "proxy-commit", 0),
            };
      return runtime.admit(input, { operationKey, requestedDeadlineAt, ...options });
    },
    inspect: runtime.inspect,
    lookup: runtime.lookup,
    requestCancel: runtime.requestCancel,
    prepareFence: (input, headers) => configurationFence.prepare(input, headers),
    inspectFence: (id, headers) => configurationFence.inspect(id, headers),
    settleFence: (input, headers) => configurationFence.settle(input, headers),
    subscribe: deps.dispatcher.subscribe,
    legacyResult: deps.dispatcher.legacyResult,
  };
}
