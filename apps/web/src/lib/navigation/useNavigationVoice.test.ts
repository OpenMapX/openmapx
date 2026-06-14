// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { primeSpeechSynthesis, useNavigationVoice } from "./useNavigationVoice";

class FakeUtterance {
  text: string;
  lang = "";
  volume = 1;
  voice: unknown = null;
  constructor(text: string) {
    this.text = text;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("useNavigationVoice", () => {
  it("speaks text via speechSynthesis", () => {
    const speak = vi.fn();
    vi.stubGlobal("window", {
      speechSynthesis: { speak, cancel: vi.fn() },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useNavigationVoice("de"));
    result.current("Turn right");
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.text).toBe("Turn right");
    expect(utterance.lang).toBe("de");
  });

  it("cancels any in-flight prompt before speaking", () => {
    const order: string[] = [];
    vi.stubGlobal("window", {
      speechSynthesis: {
        speak: () => order.push("speak"),
        cancel: () => order.push("cancel"),
      },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useNavigationVoice("en"));
    result.current("hi");
    expect(order).toEqual(["cancel", "speak"]);
  });

  it("is a no-op without speechSynthesis", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useNavigationVoice("en"));
    expect(() => result.current("hi")).not.toThrow();
  });
});

describe("primeSpeechSynthesis", () => {
  it("speaks a silent utterance to unlock TTS", () => {
    const speak = vi.fn();
    vi.stubGlobal("window", {
      speechSynthesis: { speak, cancel: vi.fn() },
      SpeechSynthesisUtterance: FakeUtterance,
    });
    vi.stubGlobal("navigator", {});
    primeSpeechSynthesis();
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).volume).toBe(0);
  });

  it("is a no-op without speechSynthesis", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect(() => primeSpeechSynthesis()).not.toThrow();
  });
});
