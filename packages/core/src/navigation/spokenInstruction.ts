import type { VoiceCue } from "./types";

/**
 * Shared maneuver wording for browser and headless navigation. Valhalla's alert
 * is an advance warning; its pre-transition text belongs immediately before
 * the turn. Succinct and post-transition text are not substitutes for these
 * phases. Engines without verbal fields fall back to their written instruction.
 */
export function spokenInstructionFor(cue: Pick<VoiceCue, "tier" | "step">): string | null {
  const { step, tier } = cue;
  const candidates =
    tier === "now"
      ? [step.verbalPre, step.instruction]
      : [step.verbalAlert, step.verbalPre, step.instruction];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}
