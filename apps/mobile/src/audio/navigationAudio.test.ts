import {
  createNavigationAudio,
  MAX_SPEECH_TEXT_LENGTH,
  type NativeNavigationAudio,
  NavigationAudioRequestError,
  validateSpeakRequest,
} from "./navigationAudio";

function fakeNative(overrides: Partial<NativeNavigationAudio> = {}): NativeNavigationAudio {
  return {
    speak: jest.fn().mockResolvedValue("spoken"),
    stop: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("navigation audio contract", () => {
  it("passes only the bounded navigation speech contract", async () => {
    const native = fakeNative();
    const audio = createNavigationAudio(native);
    await expect(
      audio.speak({ cueId: "probe:1", text: "Continue straight", locale: "en" }),
    ).resolves.toBe("spoken");
    expect(native.speak).toHaveBeenCalledWith({
      cueId: "probe:1",
      text: "Continue straight",
      locale: "en",
    });
  });

  it("forwards an in-range rate but never an out-of-range one", async () => {
    const native = fakeNative();
    const audio = createNavigationAudio(native);
    await audio.speak({ cueId: "c", text: "Turn left", locale: "de", rate: 1.2 });
    expect(native.speak).toHaveBeenCalledWith({
      cueId: "c",
      text: "Turn left",
      locale: "de",
      rate: 1.2,
    });
  });

  it("strips unknown keys so no extra field reaches native code", async () => {
    const native = fakeNative();
    const audio = createNavigationAudio(native);
    await audio.speak({
      cueId: "c",
      text: "Turn left",
      locale: "en",
      url: "https://evil.example",
    } as never);
    expect(native.speak).toHaveBeenCalledWith({ cueId: "c", text: "Turn left", locale: "en" });
  });
});

describe("navigation audio validation", () => {
  it.each(["", "x".repeat(MAX_SPEECH_TEXT_LENGTH + 1)])(
    "rejects invalid speech text of length %s",
    async (text) => {
      const audio = createNavigationAudio(fakeNative());
      await expect(audio.speak({ cueId: "probe:1", text, locale: "en" })).rejects.toThrow(
        NavigationAudioRequestError,
      );
    },
  );

  it.each(["Turn\u0000left", "Turn\u001Bleft", "Turn\u007Fleft"])(
    "rejects the control character in %j",
    (text) => {
      expect(() => validateSpeakRequest({ cueId: "c", text, locale: "en" })).toThrow(
        /control characters/,
      );
    },
  );

  it("allows a newline between two sentences", () => {
    expect(() =>
      validateSpeakRequest({ cueId: "c", text: "Turn right.\nThen continue.", locale: "en" }),
    ).not.toThrow();
  });

  it.each(["", "x".repeat(129)])("rejects an invalid cue id of length %s", (cueId) => {
    expect(() => validateSpeakRequest({ cueId, text: "Go", locale: "en" })).toThrow(/cueId/);
  });

  it.each(["fr", "en-US", "", null, undefined])("rejects the unsupported locale %p", (locale) => {
    expect(() => validateSpeakRequest({ cueId: "c", text: "Go", locale: locale as never })).toThrow(
      /locale/,
    );
  });

  it.each([0.4, 2.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the out-of-range rate %p",
    (rate) => {
      expect(() => validateSpeakRequest({ cueId: "c", text: "Go", locale: "en", rate })).toThrow(
        /rate/,
      );
    },
  );

  it("does not call native code when validation fails", async () => {
    const native = fakeNative();
    const audio = createNavigationAudio(native);
    await expect(audio.speak({ cueId: "c", text: "", locale: "en" })).rejects.toThrow();
    expect(native.speak).not.toHaveBeenCalled();
  });
});

describe("navigation audio error mapping", () => {
  it("maps a native exception to failed rather than propagating it", async () => {
    const audio = createNavigationAudio(
      fakeNative({ speak: jest.fn().mockRejectedValue(new Error("AVAudioSession busy")) }),
    );
    await expect(audio.speak({ cueId: "c", text: "Go", locale: "en" })).resolves.toBe("failed");
  });

  it("maps an unrecognised native result to failed", async () => {
    const audio = createNavigationAudio(
      fakeNative({ speak: jest.fn().mockResolvedValue("weird") as never }),
    );
    await expect(audio.speak({ cueId: "c", text: "Go", locale: "en" })).resolves.toBe("failed");
  });

  it("reports a duplicate cue as skipped", async () => {
    const audio = createNavigationAudio(
      fakeNative({ speak: jest.fn().mockResolvedValue("skipped") }),
    );
    await expect(audio.speak({ cueId: "c", text: "Go", locale: "en" })).resolves.toBe("skipped");
  });

  it("never throws from stop, so teardown always completes", async () => {
    const audio = createNavigationAudio(
      fakeNative({ stop: jest.fn().mockRejectedValue(new Error("no session")) }),
    );
    await expect(audio.stop()).resolves.toBeUndefined();
  });

  it("returns a safe status when the native module cannot report one", async () => {
    const audio = createNavigationAudio(fakeNative());
    await expect(audio.getStatus()).resolves.toEqual({
      initialized: false,
      speaking: false,
      localeAvailable: false,
      lastResultCode: null,
    });
  });

  it("passes through a real native status", async () => {
    const status = {
      initialized: true,
      speaking: false,
      localeAvailable: true,
      lastResultCode: "spoken",
    };
    const audio = createNavigationAudio(
      fakeNative({ getStatus: jest.fn().mockResolvedValue(status) }),
    );
    await expect(audio.getStatus()).resolves.toEqual(status);
  });

  it("exposes no way to reach an arbitrary native method", () => {
    const audio = createNavigationAudio(fakeNative());
    expect(Object.keys(audio).sort()).toEqual(["getStatus", "speak", "stop"]);
  });
});
