/**
 * `openmapx-navigation-audio` — the only project-owned native module in this
 * app.
 *
 * It speaks a short, already-localised string with navigation-appropriate audio
 * focus, and nothing else. There is deliberately no way to pass it a URL, a file
 * path, a locale catalogue, a notification, or a coordinate: every wording
 * decision is made in shared TypeScript so the Swift and Kotlin surface stays
 * small enough to review in one sitting.
 */

export type {
  NavigationAudioStatus,
  SpeakRequest,
  SpeakResult,
} from "./src/OpenMapXNavigationAudio.types";
export { default } from "./src/OpenMapXNavigationAudioModule";
