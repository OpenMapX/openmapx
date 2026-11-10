import type { MutationMeta } from "@tanstack/react-query";

/** Per-caller settings accepted by mutation hooks. */
export interface MutationHookOptions {
  meta?: MutationMeta;
}

/**
 * Passed by a caller that shows the mutation's failure itself, such as an
 * inline form error. The app's general failure notice then stays silent, so
 * the user never sees the same failure twice.
 *
 * An error thrown inside a hook's own `onSuccess` also fails the mutation and
 * is reported as a failed save, so those handlers must not throw.
 */
export const CALLER_SHOWS_ERRORS = {
  meta: { errorShownByCaller: true },
} as const satisfies MutationHookOptions;

export function isErrorShownByCaller(meta: MutationMeta | undefined): boolean {
  return meta?.errorShownByCaller === true;
}
