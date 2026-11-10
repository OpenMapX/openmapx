import { isApiClientError, isApiRequestAbortedError } from "@openmapx/core";
import { garageConflictSchema } from "@openmapx/core/garage-sdk";
import { savedWriteError } from "./savedWriteError";

/** A namespaced message key, with its values, explaining a failed mutation. */
export type MutationErrorMessage =
  | { namespace: "common"; key: "signedOutRetry" | "actionFailed"; values?: undefined }
  | { namespace: "vehicles"; key: "nameTaken"; values?: undefined }
  | {
      namespace: "saved";
      key: "listLimitReached" | "placeLimitReached";
      values: { count: number };
    }
  | { namespace: "saved"; key: "listNameTaken"; values?: undefined };

/** A request the app cancelled on purpose; a timeout is a failure the user sees. */
function isCancellation(error: unknown): boolean {
  if (isApiRequestAbortedError(error)) return error.code === "aborted";
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * The message for a failed mutation, or null for one the user cancelled.
 * Refusals the API explains with a declared code get their specific message.
 */
export function mutationErrorMessage(error: unknown): MutationErrorMessage | null {
  if (isCancellation(error)) return null;
  if (isApiClientError(error) && error.status === 401) {
    return { namespace: "common", key: "signedOutRetry" };
  }
  const saved = savedWriteError(error);
  if (saved.key !== "saveFailed") return { namespace: "saved", ...saved };
  if (
    isApiClientError(error) &&
    error.status === 409 &&
    garageConflictSchema.safeParse(error.payload).data?.code === "VEHICLE_NAME_TAKEN"
  ) {
    return { namespace: "vehicles", key: "nameTaken" };
  }
  return { namespace: "common", key: "actionFailed" };
}
