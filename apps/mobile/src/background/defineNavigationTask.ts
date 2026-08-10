import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { getNavigationAudio } from "../audio/navigationAudioModule";
import { getDatabase } from "../storage/database";
import { FeasibilityRepository } from "../storage/feasibilityRepository";
import { handleFeasibilityBatch } from "./handleFeasibilityBatch";
import { NAVIGATION_LOCATION_TASK } from "./taskName";

/**
 * The global background location task.
 *
 * TaskManager requires the definition to exist at module scope before React
 * renders, because the operating system can launch the process straight into
 * this callback with no UI at all. `index.ts` therefore imports this file
 * first.
 *
 * Nothing here may reach React, the WebView, a store, or a hook: in the
 * headless case none of them exist. Everything the callback needs is created
 * lazily inside it.
 */

interface LocationTaskPayload {
  locations?: LocationObject[];
}

TaskManager.defineTask<LocationTaskPayload>(NAVIGATION_LOCATION_TASK, async ({ data, error }) => {
  // The whole body is guarded: an unhandled rejection here is retried by the
  // OS, and a persistent failure would become a wake-up loop.
  try {
    const database = await getDatabase();
    const repository = new FeasibilityRepository(database);
    const effects = await handleFeasibilityBatch(
      { locations: data?.locations ?? [], errorCode: error?.code ? String(error.code) : undefined },
      { repository, nowMs: Date.now() },
    );
    // Effects run strictly after the commit, so a crash between the two loses
    // a prompt rather than repeating one.
    for (const effect of effects) {
      if (effect.kind === "speak") {
        const result = await getNavigationAudio().speak({
          cueId: effect.cueId,
          text: effect.text,
          locale: effect.locale,
        });
        // Only the stable result code is recorded — never the spoken text.
        await repository.commit((current) => ({
          ...current,
          audioResultCode: result,
          updatedAtMs: Date.now(),
        }));
      }
    }
  } catch {
    // Deliberately silent: logging here could not be redacted reliably, and
    // the failure is already observable as a stalled callback counter.
  }
});
