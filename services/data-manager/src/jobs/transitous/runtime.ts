import { db } from "../../db/index.js";
import { createSingleFlightController, type SingleFlightController } from "./single-flight.js";

/**
 * Process-wide singleton controller. The data-manager is single-instance so a
 * module-level reference is the simplest way to share the inflight lock
 * between the cron, the `POST /transit/sync` route, and any future trigger
 * surfaces (e.g. signal handlers).
 *
 * Tests should not import this — they construct isolated controllers via
 * `createSingleFlightController({ db: stub })`.
 */
let cached: SingleFlightController | null = null;

export function getSingleFlightController(): SingleFlightController {
  if (!cached) {
    cached = createSingleFlightController({ db });
  }
  return cached;
}

/** Test-only: reset the singleton (used by integration tests). */
export function __resetSingleFlightController(): void {
  cached = null;
}
