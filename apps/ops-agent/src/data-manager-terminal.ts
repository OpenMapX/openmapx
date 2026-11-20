import { readDataManagerTerminal } from "@openmapx/core/build-artifacts";
import type { ExecutionRef } from "@openmapx/core/ops";
import { configurationDataManagerTransport } from "./configuration-hardlinks-runtime";

/**
 * The terminal status of a data-manager execution, read from data-manager's
 * authenticated route on every call. Data-manager keeps the row as long as any
 * reader can ask for it; a missing or running execution is unknown.
 */
export function dataManagerTerminal(execution: ExecutionRef, signal?: AbortSignal) {
  return readDataManagerTerminal(execution, configurationDataManagerTransport(), signal);
}
