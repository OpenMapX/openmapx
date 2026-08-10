import { requireOptionalNativeModule } from "expo";
import {
  createNavigationAudio,
  type NativeNavigationAudio,
  type NavigationAudio,
} from "./navigationAudio";

/**
 * Binds the typed audio boundary to the project-owned native module.
 *
 * The lookup is optional on purpose. Under Jest, and in any build where the
 * module failed to autolink, there is no native implementation; reporting
 * `"failed"` is the honest answer and lets navigation continue silently rather
 * than crashing a background task over a missing synthesiser.
 */
const UNAVAILABLE: NativeNavigationAudio = {
  speak: async () => "failed",
  stop: async () => undefined,
  getStatus: async () => ({
    initialized: false,
    speaking: false,
    localeAvailable: false,
    lastResultCode: "module-unavailable",
  }),
};

let cached: NavigationAudio | null = null;

export function getNavigationAudio(): NavigationAudio {
  cached ??= createNavigationAudio(
    requireOptionalNativeModule<NativeNavigationAudio>("OpenMapXNavigationAudio") ?? UNAVAILABLE,
  );
  return cached;
}

/** Test seam: drops the memoised instance. */
export function resetNavigationAudioCache(): void {
  cached = null;
}
