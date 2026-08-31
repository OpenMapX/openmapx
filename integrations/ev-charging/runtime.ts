import {
  createStagedRuntimeContext,
  type IntegrationContext,
} from "@openmapx/integration-framework";

export const evRuntime = createStagedRuntimeContext<IntegrationContext>("ev-charging");

export const {
  init: initRuntime,
  begin: beginRuntimeStaging,
  stageCommit: stageRuntimeCommit,
  commit: commitRuntimeStaging,
  rollback: rollbackRuntimeStaging,
  get: getRuntimeContext,
} = evRuntime;
