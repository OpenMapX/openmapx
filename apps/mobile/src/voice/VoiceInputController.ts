import type { NativeToWebMessage } from "@openmapx/core/navigation";
import type { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import type { VoiceAudioLease } from "./audioArbiter";

type SpeechModule = Pick<
  typeof ExpoSpeechRecognitionModule,
  | "start"
  | "stop"
  | "abort"
  | "addListener"
  | "supportsOnDeviceRecognition"
  | "getMicrophonePermissionsAsync"
  | "requestMicrophonePermissionsAsync"
  | "getSpeechRecognizerPermissionsAsync"
  | "requestSpeechRecognizerPermissionsAsync"
  | "setAudioSessionActiveIOS"
  | "getSupportedLocales"
  | "androidTriggerOfflineModelDownload"
>;
type VoiceEvent = Extract<NativeToWebMessage, { type: "voice.event" }>["payload"];
type VoiceError = NonNullable<VoiceEvent["error"]>;
export interface VoiceClock {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
interface Session {
  id: string;
  channel: string;
  cancelled: boolean;
  started: boolean;
  stopping: boolean;
  /** Waiting on the OS permission prompt, which pauses the app's activity. */
  prompting: boolean;
  /** The recogniser reported an error, which ends its recognition. */
  nativeStopped: boolean;
  timers: ReturnType<typeof setTimeout>[];
  remove: (() => void)[];
  drained: Promise<void>;
  drain: () => void;
}

const downloads = new Set<string>();
const SETTLE_MS = 3000;
const RESUME_MS = 2000;
const RESUME_POLL_MS = 50;
export function selectInstalledLocale(requested: string, installed: string[]): string | undefined {
  return (
    installed.find((tag) => tag.toLowerCase() === requested.toLowerCase()) ??
    installed.find(
      (tag) => tag.split("-")[0].toLowerCase() === requested.split("-")[0].toLowerCase(),
    )
  );
}
export function mapVoiceError(error: string): VoiceError {
  if (
    [
      "not-allowed",
      "language-not-supported",
      "no-speech",
      "audio-capture",
      "busy",
      "aborted",
    ].includes(error)
  )
    return error as VoiceError;
  if (error === "speech-timeout") return "no-speech";
  if (error === "service-not-allowed") return "unavailable";
  return "generic";
}

export class VoiceInputController {
  private session: Session | null = null;
  private lease: Session | null = null;
  /** A finished session whose recogniser has not yet confirmed it stopped. */
  private unconfirmed: Session | null = null;
  constructor(
    private readonly deps: {
      module: SpeechModule;
      platform: string;
      api: number;
      audio: VoiceAudioLease;
      channel: () => string | null;
      active: () => boolean;
      emit: (event: VoiceEvent) => void;
      clock?: VoiceClock;
      downloads?: Set<string>;
    },
  ) {}
  isAvailable(): boolean {
    try {
      if (this.deps.platform === "ios")
        return ["de-DE", "en-US", "en-GB"].some((locale) =>
          this.deps.module.supportsOnDeviceRecognition(locale),
        );
      return (
        this.deps.platform === "android" &&
        this.deps.api >= 33 &&
        this.deps.module.supportsOnDeviceRecognition()
      );
    } catch {
      return false;
    }
  }
  private get clock(): VoiceClock {
    return this.deps.clock ?? { setTimeout, clearTimeout };
  }
  private current(s: Session): boolean {
    return (
      this.session === s && !s.cancelled && this.deps.channel() === s.channel && this.deps.active()
    );
  }
  private emit(s: Session, event: Omit<VoiceEvent, "requestId">): void {
    // Transcripts only reach a visible page. A terminal state must reach the
    // page that started the session even while the app is in the background,
    // or its button would keep showing "listening" after cancellation.
    const terminal = event.state === "ended" || event.state === "error";
    const owned = this.session === s && !s.cancelled && this.deps.channel() === s.channel;
    if (terminal ? owned : this.current(s)) this.deps.emit({ requestId: s.id, ...event });
  }
  /**
   * Android permission activities and iOS system alerts pause the app. The
   * permission result can arrive before active state does; wait (bounded) for it.
   */
  private async resumed(s: Session): Promise<boolean> {
    for (let waited = 0; waited < RESUME_MS; waited += RESUME_POLL_MS) {
      if (this.session !== s || s.cancelled) return false;
      if (this.deps.active()) return true;
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, RESUME_POLL_MS));
    }
    return this.current(s);
  }
  /**
   * Ends a session's ownership. `confirmed` means the recogniser itself said it
   * stopped (or never started), which is the only thing that makes it safe to
   * attach a later session's listeners: native events carry no request id.
   */
  private finish(s: Session, confirmed = true): void {
    for (const timer of s.timers) this.clock.clearTimeout(timer);
    for (const remove of s.remove) remove();
    s.remove = [];
    if (this.session === s) this.session = null;
    let released: Promise<void> | undefined;
    if (this.lease === s) {
      if (this.deps.platform === "ios") {
        const release = this.deps.audio.release(() => {
          this.deps.module.setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true });
        });
        released = Promise.resolve(release)
          .catch(() => {})
          .then(() => {
            if (this.lease === s) this.lease = null;
          });
      } else {
        this.lease = null;
        void this.deps.audio.release();
      }
    }
    if (confirmed || s.nativeStopped) {
      if (released) void released.then(s.drain);
      else s.drain();
      return;
    }
    // Wait for the recogniser's own end or error before any later session.
    this.unconfirmed = s;
    const on: SpeechModule["addListener"] = this.deps.module.addListener.bind(this.deps.module);
    const watchers: { remove: () => void }[] = [];
    const confirm = () => {
      for (const watcher of watchers) watcher.remove();
      if (this.unconfirmed === s) this.unconfirmed = null;
      if (released) void released.then(s.drain);
      else s.drain();
    };
    watchers.push(on("end", confirm), on("error", confirm));
  }
  /**
   * A started session normally finishes on the recogniser's `end`. Some
   * interruptions never deliver it. After this deadline the session releases
   * guidance and its listeners anyway, so guidance is never held for long, but
   * it stays unconfirmed: the next start aborts again and waits for the
   * recogniser to confirm, answering "busy" rather than risk receiving the old
   * recogniser's output under a new request id.
   */
  private settle(s: Session): void {
    s.timers.push(this.clock.setTimeout(() => this.finish(s, false), SETTLE_MS));
  }
  private abortQuietly(s: Session): void {
    this.emit(s, { state: "ended" });
    s.cancelled = true;
    for (const timer of s.timers) this.clock.clearTimeout(timer);
    s.timers = [];
    if (!s.started) {
      this.finish(s);
      return;
    }
    try {
      this.deps.module.abort();
    } catch {
      /* The settle deadline still releases the session. */
    }
    this.settle(s);
  }
  private fail(s: Session, error: VoiceError, abort = true): void {
    if (s.cancelled) return;
    this.emit(s, { state: "error", error });
    s.cancelled = true;
    if (!s.started) {
      this.finish(s);
      return;
    }
    if (abort) {
      try {
        this.deps.module.abort();
      } catch {
        /* The settle deadline still releases the session. */
      }
    }
    this.settle(s);
  }
  async start(id: string, locale: string): Promise<void> {
    const previous = this.session;
    this.cancel();
    const channel = this.deps.channel();
    if (!channel || !this.deps.active()) return;
    let drain = () => {};
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const s: Session = {
      id,
      channel,
      cancelled: false,
      started: false,
      stopping: false,
      prompting: false,
      nativeStopped: false,
      timers: [],
      remove: [],
      drained,
      drain,
    };
    this.session = s;
    try {
      // Native events have no request id. Never attach a new listener until the
      // previous recognizer has acknowledged end; fail closed on a stuck abort.
      const pending = this.unconfirmed ?? (previous?.started ? previous : null);
      if (pending) {
        if (pending === this.unconfirmed) {
          try {
            // Ask the stuck recogniser again; its end or error confirms it.
            this.deps.module.abort();
          } catch {
            /* Still unconfirmed: the wait below answers "busy". */
          }
        }
        const ready = await new Promise<boolean>((resolve) => {
          const timer = this.clock.setTimeout(() => resolve(false), 3000);
          void pending.drained.then(() => {
            this.clock.clearTimeout(timer);
            resolve(true);
          });
        });
        if (!this.current(s)) return;
        if (!ready) {
          this.fail(s, "busy");
          return;
        }
      }
      if (this.lease) {
        this.fail(s, "busy");
        return;
      }
      if (this.deps.platform !== "ios" && !this.isAvailable()) {
        this.fail(s, "unavailable");
        return;
      }
      let lang: string | undefined;
      if (this.deps.platform === "ios") {
        const primary = locale.split("-")[0].toLowerCase();
        lang = [locale, "de-DE", "en-US", "en-GB"]
          .filter((candidate) => candidate.split("-")[0].toLowerCase() === primary)
          .find((candidate) => this.deps.module.supportsOnDeviceRecognition(candidate));
        if (!lang) {
          this.fail(s, "language-not-supported");
          return;
        }
      }
      const permissions = [
        [
          this.deps.module.getMicrophonePermissionsAsync.bind(this.deps.module),
          this.deps.module.requestMicrophonePermissionsAsync.bind(this.deps.module),
        ],
        ...(this.deps.platform === "ios"
          ? [
              [
                this.deps.module.getSpeechRecognizerPermissionsAsync.bind(this.deps.module),
                this.deps.module.requestSpeechRecognizerPermissionsAsync.bind(this.deps.module),
              ],
            ]
          : []),
      ];
      for (const [getPermission, requestPermission] of permissions) {
        let permission = await getPermission();
        if (!this.current(s)) return;
        if (!permission.granted && permission.canAskAgain) {
          s.prompting = true;
          try {
            permission = await requestPermission();
          } finally {
            s.prompting = false;
          }
          if (!(await this.resumed(s))) {
            // The user left the app while (or right after) the prompt was open.
            if (this.session === s && !s.cancelled) this.abortQuietly(s);
            return;
          }
        }
        if (!this.current(s)) return;
        if (!permission.granted) {
          this.fail(s, "not-allowed");
          return;
        }
      }
      if (this.deps.platform !== "ios") {
        const { installedLocales } = await this.deps.module.getSupportedLocales({});
        if (!this.current(s)) return;
        lang = selectInstalledLocale(locale, installedLocales);
        if (!lang) {
          const attempted = this.deps.downloads ?? downloads;
          const key = locale.toLowerCase();
          if (!attempted.has(key)) {
            attempted.add(key);
            void this.deps.module
              .androidTriggerOfflineModelDownload({ locale })
              .catch(() => undefined);
          }
          this.fail(s, "language-not-supported");
          return;
        }
      }
      this.lease = s;
      await this.deps.audio.acquire(() => this.current(s));
      if (!this.current(s)) {
        this.finish(s);
        return;
      }
      const cleanup = (subscription: { remove: () => void }) =>
        s.remove.push(() => subscription.remove());
      const on: SpeechModule["addListener"] = this.deps.module.addListener.bind(this.deps.module);
      cleanup(on("start", () => this.emit(s, { state: "listening" })));
      cleanup(
        on("result", (event) => {
          const text = event.results[0]?.transcript.slice(0, 512);
          if (text) this.emit(s, { state: event.isFinal ? "final" : "partial", text });
        }),
      );
      cleanup(
        on("error", (event) => {
          s.nativeStopped = true;
          this.fail(s, mapVoiceError(event.error), false);
        }),
      );
      cleanup(on("nomatch", () => this.fail(s, "no-speech", false)));
      cleanup(
        on("end", () => {
          this.emit(s, { state: "ended" });
          this.finish(s);
        }),
      );
      s.started = true;
      this.deps.module.start({
        lang,
        ...(this.deps.platform === "ios"
          ? {
              iosCategory: {
                category: "playAndRecord" as const,
                mode: "measurement" as const,
                categoryOptions: ["defaultToSpeaker" as const, "allowBluetooth" as const],
              },
            }
          : {}),
        requiresOnDeviceRecognition: true,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        addsPunctuation: false,
        recordingOptions: { persist: false },
      });
      if (this.current(s)) s.timers.push(this.clock.setTimeout(() => this.stop(id), 15000));
    } catch {
      this.fail(s, "generic");
    }
  }
  stop(id: string): void {
    const s = this.session;
    if (!s || s.id !== id || s.cancelled || s.stopping) return;
    if (!s.started) {
      this.cancel(id);
      return;
    }
    s.stopping = true;
    // The user finished; if no final result arrives in time, end quietly
    // rather than reporting a failure they did not cause.
    s.timers.push(this.clock.setTimeout(() => this.abortQuietly(s), 3000));
    try {
      this.deps.module.stop();
    } catch {
      this.fail(s, "generic");
    }
  }
  cancel(id?: string): void {
    const s = this.session;
    if (!s || s.cancelled || (id !== undefined && s.id !== id)) return;
    this.abortQuietly(s);
  }
  /**
   * The app left the foreground. Cancels like `cancel()`, except while the OS
   * permission prompt is open: that prompt is what paused the app, and nothing
   * is being recorded yet. `start` re-checks the foreground once it closes.
   */
  suspend(): void {
    if (this.session?.prompting) return;
    this.cancel();
  }
}
