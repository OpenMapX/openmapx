import { ApiClientError, createApiClient, isApiRequestAbortedError } from "@openmapx/core";
import type { AdminExtensionInstallPreview } from "@openmapx/core/api-admin-sdk";
import { log } from "./output";

export const EXTENSION_READ_TIMEOUT_MS = 30_000;
export const EXTENSION_RESOLUTION_TIMEOUT_MS = 180_000;

/** Each action owns its API destination; env loading happens after module imports. */
export function createExtensionAdminClient() {
  return createApiClient({
    baseUrl: process.env.API_URL ?? process.env.OPENMAPX_API_URL ?? "http://localhost:3001",
    credentials: "omit",
    headerInterceptor: () => ({
      "x-openmapx-local-admin": process.env.OPENMAPX_LOCAL_ADMIN_TOKEN?.trim() ?? "",
    }),
  });
}

/** Only fixed local messages and validated status/retry metadata reach stderr. */
export async function runExtensionAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof HostPortReviewRequired) {
      log.err(
        "Host-port confirmation is missing or no longer matches the current preview. Run ext preview <idOrUrl>, inspect the complete current snapshot, then deliberately supply --host-port-confirmation <fingerprint>. For an update, preview the same catalog ID. Review again if the snapshot changed.",
      );
    } else if (isApiRequestAbortedError(error)) {
      log.err(
        "Extension request ended without a confirmed result. Work may still be running; this does not cancel a host job. Check Admin → Activity before deliberately retrying. No automatic retry was made.",
      );
    } else if (error instanceof ApiClientError) {
      log.err(
        error.status === 429
          ? `HTTP 429: Extension request rate limited. Respect Retry-After${error.retryAfterSeconds === null ? "" : ` (${error.retryAfterSeconds}s)`}; review before a deliberate retry. No automatic retry was made.`
          : `HTTP ${error.status}: Extension request rejected. Check administrator access, extension policy and the requested action.`,
      );
    } else {
      log.err(
        "Extension request failed without a validated result. Check API availability and Admin → Activity before deliberately retrying. No automatic retry was made.",
      );
    }
    process.exitCode = 1;
  }
}

class HostPortReviewRequired extends Error {}

/** A fresh preview is a check, never consent. Worker enforcement remains authoritative. */
export function requireHostPortReview(
  preview: AdminExtensionInstallPreview,
  supplied: string | undefined,
): void {
  const hasPorts = preview.services.some((service) => service.hostPorts.length > 0);
  if (
    (hasPorts || preview.requiresHostPortConfirmation || supplied !== undefined) &&
    supplied !== preview.confirmation
  ) {
    throw new HostPortReviewRequired();
  }
}

export function printExtensionPreview(preview: AdminExtensionInstallPreview): void {
  log.info("Inspected extension preview (may fetch and stage repositories):");
  // Complete validated projection, with JSON-escaped manifest text for the terminal.
  log.info(JSON.stringify(preview, null, 2));
  log.info(
    "Inspect all fields before install/update. For host ports, deliberately supply --host-port-confirmation <fingerprint> using the inspected confirmation value. A changed snapshot requires a new review. Acceptance is queued; check Admin → Activity for completion.",
  );
}
