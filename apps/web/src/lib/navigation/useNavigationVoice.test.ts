// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigationVoice } from "./useNavigationVoice";

afterEach(() => vi.unstubAllGlobals());

describe("useNavigationVoice", () => {
  it("speaks text via speechSynthesis", () => {
    const speak = vi.fn();
    class FakeUtterance {
      text: string;
      lang = "";
      constructor(text: string) {
        this.text = text;
      }
    }
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

  it("is a no-op without speechSynthesis", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useNavigationVoice("en"));
    expect(() => result.current("hi")).not.toThrow();
  });
});
