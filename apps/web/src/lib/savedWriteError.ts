import {
  isApiClientError,
  MAX_SAVED_LISTS_PER_USER,
  MAX_SAVED_PLACES_PER_USER,
} from "@openmapx/core";
import { savedConflictSchema } from "@openmapx/core/saved-places-sdk";

/** A `saved` message key and its values explaining why a saved-data write was refused. */
export type SavedWriteError =
  | { key: "listLimitReached"; values: { count: number } }
  | { key: "placeLimitReached"; values: { count: number } }
  | { key: "saveFailed"; values?: undefined };

/** Reads only the declared conflict codes; any other failure gets the generic message. */
export function savedWriteError(error: unknown): SavedWriteError {
  if (isApiClientError(error) && error.status === 409) {
    const conflict = savedConflictSchema.safeParse(error.payload);
    if (conflict.success && conflict.data.code === "SAVED_LIST_LIMIT")
      return { key: "listLimitReached", values: { count: MAX_SAVED_LISTS_PER_USER } };
    if (conflict.success && conflict.data.code === "SAVED_PLACE_LIMIT")
      return { key: "placeLimitReached", values: { count: MAX_SAVED_PLACES_PER_USER } };
  }
  return { key: "saveFailed" };
}
