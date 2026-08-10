import { getNavigationAudio } from "../audio/navigationAudioModule";
import { getDatabase } from "../storage/database";
import { FeasibilityRepository } from "../storage/feasibilityRepository";
import { handleFeasibilityBatch, type RawLocation } from "./handleFeasibilityBatch";

/**
 * The qualification probe's side of the background callback.
 *
 * Separated from the task definition so the production path does not import it
 * transitively, and so `mobile:bundle:check` can see plainly which modules a
 * release build actually reaches. A build without the feasibility flag never
 * calls this, and the release configuration refuses to validate with that flag
 * set at all.
 */
export async function runFeasibilityProbe(batch: {
  locations: readonly RawLocation[];
  errorCode?: string;
}): Promise<void> {
  const repository = new FeasibilityRepository(await getDatabase());
  const effects = await handleFeasibilityBatch(batch, { repository, nowMs: Date.now() });

  // Effects run strictly after the commit, so a crash between the two loses a
  // prompt rather than repeating one.
  for (const effect of effects) {
    if (effect.kind !== "speak") continue;
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
