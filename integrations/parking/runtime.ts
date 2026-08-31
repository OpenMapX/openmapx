import {
  createStagedRuntimeContext,
  type IntegrationContext,
} from "@openmapx/integration-framework";

export const parkingRuntime = createStagedRuntimeContext<IntegrationContext>("parking");

export const {
  init: initRuntime,
  begin: beginRuntimeStaging,
  stageCommit: stageRuntimeCommit,
  commit: commitRuntimeStaging,
  rollback: rollbackRuntimeStaging,
  get: getRuntimeContext,
} = parkingRuntime;
