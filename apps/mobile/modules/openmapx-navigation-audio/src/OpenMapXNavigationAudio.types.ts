/** The complete data contract between JavaScript and the native synthesiser. */

export type SpeakResult = "spoken" | "skipped" | "failed";

export interface SpeakRequest {
  /** Stable identity used for native-side duplicate suppression. */
  cueId: string;
  /** Already-localised text, 1–512 UTF-16 code units. */
  text: string;
  locale: "en" | "de";
  /** Optional rate multiplier between 0.5 and 2.0. */
  rate?: number;
}

export interface NavigationAudioStatus {
  initialized: boolean;
  speaking: boolean;
  localeAvailable: boolean;
  lastResultCode: string | null;
}

export interface OpenMapXNavigationAudioModuleContract {
  speak(request: SpeakRequest): Promise<SpeakResult>;
  stop(): Promise<void>;
  getStatus(): Promise<NavigationAudioStatus>;
}
