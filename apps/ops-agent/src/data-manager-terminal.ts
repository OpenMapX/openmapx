import {
  type ControlInstallation,
  readDataControlTerminalObservation,
  recordDataControlTerminalObservation,
} from "@openmapx/core/build-artifacts";
import { lookupDataExecution, unwrapDataManagerResponse } from "@openmapx/core/data-manager-sdk";
import type { ExecutionRef } from "@openmapx/core/ops";
import { configurationDataManagerTransport } from "./configuration-hardlinks-runtime";

/**
 * The terminal status of a data-manager execution, as data-manager reports it
 * to the agent over its authenticated route. The first terminal answer is
 * recorded in the agent's own state and every later read returns that record.
 */
export async function dataManagerTerminal(
  installation: ControlInstallation,
  execution: ExecutionRef,
  signal?: AbortSignal,
) {
  try {
    return readDataControlTerminalObservation(installation, execution);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const status = unwrapDataManagerResponse(
    await lookupDataExecution(execution.operationKey, {
      transport: configurationDataManagerTransport(),
      signal,
    }),
  );
  return recordDataControlTerminalObservation(installation, execution, status);
}
