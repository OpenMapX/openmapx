import { OpsObservationPending } from "../services/ops-client";

/** Test-only resumption of a retained read, never a scenario/effect retry. Each
 * request keeps its real timeout; authority and execution deadlines stay fixed. */
export async function observeOriginalOperation<T>(
  observe: () => Promise<T>,
  identity: OpsObservationPending["identity"],
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await observe();
    } catch (error) {
      if (
        attempt >= 3 ||
        signal.aborted ||
        !(error instanceof OpsObservationPending) ||
        error.reason !== "unavailable" ||
        error.identity.kind !== identity.kind ||
        error.identity.operationKey !== identity.operationKey ||
        error.identity.operationId !== identity.operationId
      )
        throw error;
    }
  }
}
