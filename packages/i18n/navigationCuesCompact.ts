/**
 * Navigation cue formatting for browser bundles: the same output as
 * `./navigationCues`, read from the generated cue-only catalogue (about 2 kB)
 * instead of every full message catalogue. Works offline and synchronously.
 */
import cueMessages from "./generated/navigation-cue-messages.json";
import { createNavigationCueFormatter } from "./navigationCueFormatter";

export {
  NavigationCueError,
  type NavigationCueReference,
  type NavigationLandmarkCategory,
} from "./navigationCueFormatter";
export { startsWithReferenceStarter } from "./navigationReferenceStarters";

export const { formatNavigationCue } = createNavigationCueFormatter(cueMessages);
