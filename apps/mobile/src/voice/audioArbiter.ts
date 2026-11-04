import {
  type NavigationAudio,
  type SpeakRequest,
  validateSpeakRequest,
} from "../audio/navigationAudio";

export interface VoiceAudioLease {
  acquire(isCurrent: () => boolean): Promise<void>;
  release(): void;
}

/** One runtime-wide gate, including callers outside the foreground shell. */
export function createAudioArbiter(
  audio: NavigationAudio,
  now = Date.now,
  delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): NavigationAudio & VoiceAudioLease {
  let held = false;
  let latest: { request: SpeakRequest; at: number } | null = null;
  let outcome: string | null = null;
  let pendingSpeech = 0;
  async function speak(request: SpeakRequest) {
    pendingSpeech += 1;
    try {
      return await audio.speak(request);
    } finally {
      pendingSpeech -= 1;
    }
  }
  return {
    async speak(request) {
      validateSpeakRequest(request);
      if (held) {
        latest = { request, at: now() };
        outcome = "voice-guidance-held";
        return "skipped";
      }
      return speak(request);
    },
    async stop() {
      latest = null;
      await audio.stop();
    },
    async getStatus() {
      return { ...(await audio.getStatus()), ...(outcome ? { lastResultCode: outcome } : {}) };
    },
    async acquire(isCurrent) {
      held = true;
      const deadline = now() + 6000;
      while (isCurrent() && (pendingSpeech > 0 || (await audio.getStatus()).speaking)) {
        if (now() >= deadline) break;
        await delay(50);
      }
      if (!isCurrent()) return;
      // Android's status can become idle when the first queued cue ends.
      // Flush any remaining native queue before acquiring the microphone.
      await audio.stop();
      if (pendingSpeech > 0 || (await audio.getStatus()).speaking) {
        throw new Error("guidance-still-speaking");
      }
    },
    release() {
      held = false;
      const cue = latest;
      latest = null;
      if (!cue) return;
      if (now() - cue.at > 10000) {
        outcome = "voice-guidance-stale";
        return;
      }
      outcome = "voice-guidance-released";
      void speak(cue.request);
    },
  };
}
