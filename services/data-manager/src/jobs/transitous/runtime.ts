import { createSingleFlightController, type SingleFlightController } from "./single-flight.js";

/**
 * Process-wide singleton controller. The data-manager is single-instance so a
 * module-level reference is the simplest way to share the inflight latch
 * between the sync worker and the shutdown path.
 *
 * Tests should not import this — they construct isolated controllers via
 * `createSingleFlightController()`.
 */
let cached: SingleFlightController | null = null;

export function getSingleFlightController(): SingleFlightController {
  cached ??= createSingleFlightController();
  return cached;
}
