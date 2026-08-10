import { requireNativeModule } from "expo";
import type { OpenMapXNavigationAudioModuleContract } from "./OpenMapXNavigationAudio.types";

/**
 * Resolves the autolinked native module. This is a hard `requireNativeModule`
 * rather than the optional form because a build that reached this import is
 * expected to contain the module; the app-level wrapper
 * (`src/audio/navigationAudioModule.ts`) is the place that tolerates its
 * absence, so tests and misconfigured builds degrade instead of crashing.
 */
export default requireNativeModule<OpenMapXNavigationAudioModuleContract>(
  "OpenMapXNavigationAudio",
);
