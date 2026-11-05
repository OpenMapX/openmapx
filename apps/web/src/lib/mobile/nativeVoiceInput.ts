import type { VoiceEvent } from "@openmapx/core/navigation";
import type { BridgeClient } from "./bridgeClient";

export interface NativeVoiceCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onEnd(): void;
  onError(error: NonNullable<VoiceEvent["error"]>): void;
}

/** Owns one utterance; stop preserves results, cancel revokes their delivery. */
export class NativeVoiceInput {
  private session: { requestId: string; unsubscribe: () => void } | null = null;

  constructor(private readonly client: Pick<BridgeClient, "send" | "subscribe">) {}

  start(locale: string, callbacks: NativeVoiceCallbacks): void {
    this.cancel();
    const requestId = crypto.randomUUID();
    const unsubscribe = this.client.subscribe((message) => {
      if (message.type !== "voice.event" || this.session?.requestId !== requestId) return;
      const event = message.payload;
      if (event.requestId !== requestId) return;
      if (event.state === "partial" || event.state === "final") {
        const text = event.text?.trim();
        if (text) {
          if (event.state === "partial") callbacks.onPartial(text);
          else callbacks.onFinal(text);
        }
      } else if (event.state === "ended" || event.state === "error") {
        this.release();
        if (event.state === "error") callbacks.onError(event.error ?? "generic");
        else callbacks.onEnd();
      }
    });
    this.session = { requestId, unsubscribe };
    try {
      this.client.send("voice.start", { requestId, locale });
    } catch {
      this.release();
      callbacks.onError("generic");
    }
  }

  stop(): void {
    if (!this.session) return;
    try {
      this.client.send("voice.stop", { requestId: this.session.requestId });
    } catch {
      this.cancel();
    }
  }

  cancel(): void {
    const session = this.session;
    this.release();
    if (!session) return;
    try {
      this.client.send("voice.cancel", { requestId: session.requestId });
    } catch {
      // A replaced/closed document channel already revokes native ownership.
    }
  }

  private release(): void {
    const session = this.session;
    this.session = null;
    session?.unsubscribe();
  }
}
