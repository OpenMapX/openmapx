import { createAudioArbiter } from "./audioArbiter";
import { mapVoiceError, selectInstalledLocale, VoiceInputController } from "./VoiceInputController";

function fixture(
  platform = "android",
  api = 33,
  supported = true,
  audioOverride?: ConstructorParameters<typeof VoiceInputController>[0]["audio"],
) {
  const handlers = new Map<string, Set<(event: never) => void>>();
  const fire = (name: string, event: unknown = {}) => {
    for (const handler of [...(handlers.get(name) ?? [])]) handler(event as never);
  };
  const module = {
    supportsOnDeviceRecognition: jest.fn((_locale?: string) => supported),
    getMicrophonePermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    requestMicrophonePermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
    getSpeechRecognizerPermissionsAsync: jest.fn(async () => ({
      granted: true,
      canAskAgain: true,
    })),
    requestSpeechRecognizerPermissionsAsync: jest.fn(async () => ({
      granted: true,
      canAskAgain: true,
    })),
    setAudioSessionActiveIOS: jest.fn(),
    getSupportedLocales: jest.fn(async () => ({
      installedLocales: ["de-DE", "en-US"],
      locales: ["fr-FR"],
    })),
    androidTriggerOfflineModelDownload: jest.fn(async () => ({})),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    addListener: jest.fn((name: string, listener: (event: never) => void) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(listener);
      return { remove: () => set.delete(listener) };
    }),
  };
  const emit = jest.fn();
  const audio = { acquire: jest.fn(async () => {}), release: jest.fn() };
  let channel: string | null = "document-a";
  let active = true;
  const controller = new VoiceInputController({
    module: module as unknown as ConstructorParameters<typeof VoiceInputController>[0]["module"],
    platform,
    api,
    audio: audioOverride ?? audio,
    emit,
    channel: () => channel,
    active: () => active,
    downloads: new Set(),
  });
  return {
    controller,
    module,
    emit,
    audio,
    fire,
    setChannel: (value: string | null) => {
      channel = value;
    },
    background: () => {
      active = false;
      controller.cancel();
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe("native voice input", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it.each([
    ["ios", 35, false],
    ["android", 32, true],
    ["android", 35, false],
  ])("fails closed on %s API %s supported %s", (os, api, supported) => {
    expect(fixture(os, api, supported).controller.isAvailable()).toBe(false);
  });
  it("uses only installed locales, exact first then primary language", () => {
    expect(selectInstalledLocale("en-US", ["en-GB", "en-US"])).toBe("en-US");
    expect(selectInstalledLocale("en-AU", ["de-DE", "en-GB"])).toBe("en-GB");
    expect(selectInstalledLocale("fr-FR", ["en-US"])).toBeUndefined();
  });
  it("starts on-device without persistence or volume events and emits bounded results", async () => {
    const f = fixture();
    await f.controller.start("r1", "de-DE");
    expect(f.module.requestMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(f.module.start).toHaveBeenCalledWith({
      lang: "de-DE",
      requiresOnDeviceRecognition: true,
      interimResults: true,
      continuous: false,
      maxAlternatives: 1,
      addsPunctuation: false,
      recordingOptions: { persist: false },
    });
    f.fire("start");
    f.fire("result", { isFinal: false, results: [{ transcript: "Berlin" }] });
    f.fire("result", { isFinal: true, results: [{ transcript: "x".repeat(600) }] });
    f.fire("end");
    expect(f.emit.mock.calls.map(([e]) => e.state)).toEqual([
      "listening",
      "partial",
      "final",
      "ended",
    ]);
    expect(f.emit.mock.calls[2][0].text).toHaveLength(512);
    expect(f.audio.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    [true, "android"],
    [false, "android"],
    [true, "ios"],
    [false, "ios"],
  ] as const)("denial canAskAgain=%s platform=%s", async (canAskAgain, platform) => {
    const f = fixture(platform);
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain });
    f.module.requestMicrophonePermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    await f.controller.start("r", "en-US");
    expect(f.module.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(canAskAgain ? 1 : 0);
    expect(f.emit).toHaveBeenCalledWith({ requestId: "r", state: "error", error: "not-allowed" });
    expect(f.module.start).not.toHaveBeenCalled();
  });
  it("requests first-tap permission then starts", async () => {
    const f = fixture();
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    await f.controller.start("r", "en-US");
    expect(f.module.start).toHaveBeenCalledTimes(1);
  });
  it("downloads missing model once and rechecks installed models every start", async () => {
    const f = fixture();
    await f.controller.start("r", "fr-FR");
    await f.controller.start("s", "fr-FR");
    expect(f.module.androidTriggerOfflineModelDownload).toHaveBeenCalledTimes(1);
    expect(f.module.getSupportedLocales).toHaveBeenCalledTimes(2);
    expect(f.module.start).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenLastCalledWith({
      requestId: "s",
      state: "error",
      error: "language-not-supported",
    });
  });
  it("stop preserves final results, then ends quietly at 3 seconds without end", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.controller.stop("r");
    f.fire("result", { isFinal: true, results: [{ transcript: "Berlin" }] });
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "r", state: "final", text: "Berlin" });
    jest.advanceTimersByTime(3000);
    expect(f.module.abort).toHaveBeenCalledTimes(1);
    f.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "r", state: "ended" });
    expect(f.emit.mock.calls.some(([event]) => event.state === "error")).toBe(false);
  });
  it("releases guidance when the recogniser never ends after abort, but keeps it unconfirmed", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.controller.cancel("r");
    expect(f.audio.release).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(3000);
    expect(f.audio.release).toHaveBeenCalledTimes(1);
    // A new start asks the stuck recogniser again and must not attach
    // listeners until it confirms; the old recogniser's output arrives first.
    f.emit.mockClear();
    const next = f.controller.start("s", "en-US");
    await jest.advanceTimersByTimeAsync(10);
    expect(f.module.abort).toHaveBeenCalledTimes(2);
    f.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
    expect(f.module.start).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3000);
    await next;
    expect(f.module.start).toHaveBeenCalledTimes(1);
    expect(f.emit.mock.calls.some(([event]) => event.text === "late")).toBe(false);
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "s", state: "error", error: "busy" });
  });
  it("starts again once the stuck recogniser finally confirms its end", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.controller.cancel("r");
    await jest.advanceTimersByTimeAsync(3000);
    const next = f.controller.start("s", "en-US");
    await jest.advanceTimersByTimeAsync(10);
    f.fire("end");
    await jest.advanceTimersByTimeAsync(10);
    await next;
    expect(f.module.start).toHaveBeenCalledTimes(2);
    f.fire("result", { isFinal: true, results: [{ transcript: "Aachen" }] });
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "s", state: "final", text: "Aachen" });
  });
  it("survives the permission prompt pausing the app and starts once it resumes", async () => {
    const f = fixture();
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    f.module.requestMicrophonePermissionsAsync.mockImplementation(async () => {
      // Android's prompt is another activity: the app reads as backgrounded,
      // and the lifecycle hook suspends voice input.
      f.setActive(false);
      f.controller.suspend();
      return { granted: true, canAskAgain: true };
    });
    const start = f.controller.start("r", "en-US");
    // The permission result arrives before the activity resumes.
    await jest.advanceTimersByTimeAsync(100);
    expect(f.module.start).not.toHaveBeenCalled();
    f.setActive(true);
    await jest.advanceTimersByTimeAsync(100);
    await start;
    expect(f.module.start).toHaveBeenCalledTimes(1);
  });
  it("reports a refusal from the prompt to the page", async () => {
    const f = fixture();
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    f.module.requestMicrophonePermissionsAsync.mockImplementation(async () => {
      f.setActive(false);
      f.controller.suspend();
      f.setActive(true);
      return { granted: false, canAskAgain: true };
    });
    await f.controller.start("r", "en-US");
    expect(f.emit).toHaveBeenLastCalledWith({
      requestId: "r",
      state: "error",
      error: "not-allowed",
    });
  });
  it("ends quietly without recording when the user stays away after the prompt", async () => {
    const f = fixture();
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    f.module.requestMicrophonePermissionsAsync.mockImplementation(async () => {
      f.setActive(false);
      return { granted: true, canAskAgain: true };
    });
    const start = f.controller.start("r", "en-US");
    await jest.advanceTimersByTimeAsync(2500);
    await start;
    expect(f.module.start).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "r", state: "ended" });
  });
  it("tells the page listening ended when the app goes to the background", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.setActive(false);
    f.controller.suspend();
    expect(f.module.abort).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "r", state: "ended" });
    // Transcripts never reach a backgrounded page.
    f.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
    expect(f.emit.mock.calls.some(([event]) => event.text === "late")).toBe(false);
  });
  it("releases guidance when a native error is never followed by end", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.fire("error", { error: "audio-capture" });
    jest.advanceTimersByTime(3000);
    expect(f.audio.release).toHaveBeenCalledTimes(1);
  });
  it("caps utterances at 15 seconds", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    jest.advanceTimersByTime(15000);
    expect(f.module.stop).toHaveBeenCalledTimes(1);
    f.fire("end");
    jest.advanceTimersByTime(3000);
    expect(f.module.abort).not.toHaveBeenCalled();
  });
  it.each(["cancel", "background", "document"])(
    "discards late results after %s",
    async (reason) => {
      const f = fixture();
      await f.controller.start("r", "en-US");
      if (reason === "background") f.background();
      else if (reason === "document") f.setChannel("document-b");
      else f.controller.cancel("r");
      f.emit.mockClear();
      f.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
      f.fire("end");
      expect(f.emit).not.toHaveBeenCalled();
    },
  );
  it("new start waits for abort end and cannot inherit a late result", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    const next = f.controller.start("s", "de-DE");
    f.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
    expect(f.module.start).toHaveBeenCalledTimes(1);
    f.fire("end");
    await next;
    expect(f.module.start).toHaveBeenCalledTimes(2);
    expect(f.emit.mock.calls.some(([e]) => e.text === "late")).toBe(false);
  });
  it("stuck abort fails closed instead of sharing native events", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    const next = f.controller.start("s", "en-US");
    jest.advanceTimersByTime(3000);
    await next;
    expect(f.module.start).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "s", state: "error", error: "busy" });
  });
  it.each([
    ["network", "generic"],
    ["service-not-allowed", "unavailable"],
    ["speech-timeout", "no-speech"],
    ["audio-capture", "audio-capture"],
  ])("maps %s to %s", (input, output) => expect(mapVoiceError(input)).toBe(output));
  it("nomatch is terminal and waits for native teardown", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.fire("nomatch");
    expect(f.emit).toHaveBeenLastCalledWith({ requestId: "r", state: "error", error: "no-speech" });
    f.fire("end");
    expect(f.audio.release).toHaveBeenCalled();
  });
  it("cancellation during a permission request cannot start recognition later", async () => {
    const f = fixture();
    let resolve!: (value: { granted: boolean; canAskAgain: boolean }) => void;
    f.module.getMicrophonePermissionsAsync.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = f.controller.start("r", "en-US");
    f.controller.cancel("r");
    resolve({ granted: true, canAskAgain: true });
    await start;
    expect(f.module.start).not.toHaveBeenCalled();
  });
  it("native error owns teardown; no duplicate abort/end enters a new session", async () => {
    const f = fixture();
    await f.controller.start("r", "en-US");
    f.fire("nomatch");
    f.fire("error", { error: "no-speech" });
    f.controller.cancel("r");
    expect(f.module.abort).not.toHaveBeenCalled();
    expect(f.emit.mock.calls.filter(([event]) => event.state === "error")).toHaveLength(1);
    f.fire("end");
    expect(f.audio.release).toHaveBeenCalledTimes(1);
  });
});

describe("iOS on-device voice input", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it("probes app languages individually and stays hidden when none works", () => {
    const f = fixture("ios");
    f.module.supportsOnDeviceRecognition.mockImplementation(
      (locale?: string) => locale === "en-GB",
    );
    expect(f.controller.isAvailable()).toBe(true);
    expect(f.module.supportsOnDeviceRecognition.mock.calls).toEqual([
      ["de-DE"],
      ["en-US"],
      ["en-GB"],
    ]);
    f.module.supportsOnDeviceRecognition.mockReturnValue(false);
    expect(f.controller.isAvailable()).toBe(false);
  });
  it("fails before recording or prompts for a missing language, never downloading", async () => {
    const f = fixture("ios");
    f.module.supportsOnDeviceRecognition.mockImplementation(
      (locale?: string) => locale === "de-DE",
    );
    await f.controller.start("r", "en-AU");
    expect(f.emit).toHaveBeenLastCalledWith({
      requestId: "r",
      state: "error",
      error: "language-not-supported",
    });
    expect(f.module.start).not.toHaveBeenCalled();
    expect(f.audio.acquire).not.toHaveBeenCalled();
    expect(f.module.getMicrophonePermissionsAsync).not.toHaveBeenCalled();
    expect(f.module.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
  });
  it.each(["en-AU", "en-GB"])("selects same-language offline locale for %s", async (locale) => {
    const f = fixture("ios");
    f.module.supportsOnDeviceRecognition.mockImplementation((tag?: string) => tag === "en-GB");
    await f.controller.start("r", locale);
    expect(f.module.start).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: "en-GB",
        requiresOnDeviceRecognition: true,
        iosCategory: {
          category: "playAndRecord",
          mode: "measurement",
          categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
        },
      }),
    );
    expect(f.module.getSupportedLocales).not.toHaveBeenCalled();
    expect(f.module.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
    f.fire("error", { error: "language-not-supported" });
    expect(f.emit).toHaveBeenLastCalledWith({
      requestId: "r",
      state: "error",
      error: "language-not-supported",
    });
    f.fire("end");
  });
  it.each([true, false])("speech permission denial canAskAgain=%s", async (canAskAgain) => {
    const f = fixture("ios");
    f.module.getSpeechRecognizerPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain });
    f.module.requestSpeechRecognizerPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    await f.controller.start("r", "en-US");
    expect(f.module.requestSpeechRecognizerPermissionsAsync).toHaveBeenCalledTimes(
      canAskAgain ? 1 : 0,
    );
    expect(f.emit).toHaveBeenLastCalledWith({
      requestId: "r",
      state: "error",
      error: "not-allowed",
    });
    expect(f.module.start).not.toHaveBeenCalled();
  });
  it("requests both permissions, survives inactive alerts and waits for active", async () => {
    const f = fixture("ios");
    f.module.getMicrophonePermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    f.module.getSpeechRecognizerPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    });
    f.module.requestSpeechRecognizerPermissionsAsync.mockImplementation(async () => {
      f.setActive(false);
      f.controller.suspend();
      return { granted: true, canAskAgain: true };
    });
    const start = f.controller.start("r", "en-US");
    await jest.advanceTimersByTimeAsync(100);
    expect(f.module.start).not.toHaveBeenCalled();
    f.setActive(true);
    await jest.advanceTimersByTimeAsync(100);
    await start;
    expect(f.module.requestMicrophonePermissionsAsync).toHaveBeenCalledTimes(1);
    expect(f.module.requestSpeechRecognizerPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(f.module.start).toHaveBeenCalledTimes(1);
    f.fire("end");
  });
  it.each([false, true])(
    "hands back before held guidance, except when speaking=%s",
    async (speaking) => {
      const order: string[] = [];
      let guidanceSpeaking = false;
      const arbiter = createAudioArbiter({
        speak: jest.fn(async () => {
          order.push("cue");
          return "spoken" as const;
        }),
        stop: jest.fn(async () => {}),
        getStatus: jest.fn(async () => ({
          initialized: true,
          speaking: guidanceSpeaking,
          localeAvailable: true,
          lastResultCode: null,
        })),
      });
      const f = fixture("ios", 35, true, arbiter);
      f.module.setAudioSessionActiveIOS.mockImplementation(() => {
        order.push("deactivate");
      });
      await f.controller.start("r", "en-US");
      await arbiter.speak({ cueId: "held", text: "Turn left", locale: "en" });
      guidanceSpeaking = speaking;
      order.push("end");
      f.fire("end");
      await jest.advanceTimersByTimeAsync(0);
      expect(order).toEqual(speaking ? ["end", "cue"] : ["end", "deactivate", "cue"]);
      if (!speaking)
        expect(f.module.setAudioSessionActiveIOS).toHaveBeenCalledWith(false, {
          notifyOthersOnDeactivation: true,
        });
    },
  );
});
