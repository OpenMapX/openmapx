import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { getRuntimeConfig } from "../config/runtimeConfig";
import { getHeadlessCoordinator } from "./createHeadlessCoordinator";
import { NAVIGATION_LOCATION_TASK } from "./taskName";

/**
 * The global background location task.
 *
 * TaskManager requires the definition to exist at module scope before React
 * renders, because the operating system can launch the process straight into
 * this callback with no UI at all. `index.ts` therefore imports this file first.
 *
 * Nothing at module scope may reach React, the WebView, a store or a hook: in
 * the headless case none of them exist. Everything the callback needs — the
 * database, the coordinator, the driver — is created lazily inside it.
 */

interface LocationTaskPayload {
  locations?: LocationObject[];
}

TaskManager.defineTask<LocationTaskPayload>(NAVIGATION_LOCATION_TASK, async ({ data, error }) => {
  // The whole body is guarded: an unhandled rejection here is retried by the
  // operating system, and a persistent failure would become a wake-up loop.
  try {
    const batch = {
      locations: data?.locations ?? [],
      ...(error?.code ? { errorCode: String(error.code) } : {}),
    };

    // The qualification probe is not a second navigation path — it is the only
    // path in a build that has no session to advance.
    //
    // `__DEV__` is a compile-time constant, so the whole branch, including the
    // `require`, is removed from a release bundle rather than merely skipped.
    // Nothing is lost by that: the configuration refuses to validate a release
    // build with the feasibility flag set, so the branch could never run there.
    // `mobile:bundle:check` asserts the probe is genuinely absent.
    if (__DEV__ && isFeasibilityBuild()) {
      const { runFeasibilityProbe } =
        require("./feasibilityProbe") as typeof import("./feasibilityProbe");
      await runFeasibilityProbe(batch);
      return;
    }

    const coordinator = await getHeadlessCoordinator();
    await coordinator.handleLocationBatch(batch);
  } catch {
    // Deliberately silent: logging here could not be redacted reliably, and the
    // failure is already observable in the local diagnostic ring.
  }
});

/**
 * Whether this build carries the qualification probe.
 *
 * Read through the compiled configuration rather than a bare environment check,
 * so the release validation that forbids the flag is the same gate the task
 * consults.
 */
function isFeasibilityBuild(): boolean {
  try {
    return getRuntimeConfig().feasibilityMode;
  } catch {
    return false;
  }
}
