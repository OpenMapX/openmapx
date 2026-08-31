import {
  createStagedRuntimeContext,
  type IntegrationContext,
} from "@openmapx/integration-framework";

export const {
  init: initRuntime,
  begin: beginRuntimeStaging,
  stageCommit: stageRuntimeCommit,
  commit: commitRuntimeStaging,
  rollback: rollbackRuntimeStaging,
  get: getRuntimeContext,
} = createStagedRuntimeContext<IntegrationContext>("ev-charging");
