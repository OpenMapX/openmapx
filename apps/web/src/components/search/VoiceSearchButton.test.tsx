import type { NativeToWebMessage } from "@openmapx/core/navigation";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_RUNTIME, type MobileRuntime } from "@/lib/mobile/MobileRuntimeProvider";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";
import { act, fireEvent, render, screen, waitFor } from "@/test";
import { VoiceSearchButton } from "./VoiceSearchButton";

const runtime = vi.hoisted(() => ({ current: null as MobileRuntime | null }));
vi.mock("@/lib/mobile/MobileRuntimeProvider", async (original) => {
  const actual = await original<typeof import("@/lib/mobile/MobileRuntimeProvider")>();
  return { ...actual, useMobileRuntimeContext: () => runtime.current ?? actual.BROWSER_RUNTIME };
});

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

/** Fake Web Speech recognition that records the constructed instance. */
function installFakeRecognition() {
  const recRef: {
    current: {
      lang: string;
      start: ReturnType<typeof vi.fn>;
      onresult: ((e: unknown) => void) | null;
      onerror: ((e: { error: string }) => void) | null;
    } | null;
  } = { current: null };
  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      recRef.current = this;
    }
  }
  (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
    FakeRecognition;
  return recRef;
}

function uninstall() {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
}

function setMediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}

describe("VoiceSearchButton", () => {
  it("renders the mic button once SpeechRecognition is feature-detected", async () => {
    installFakeRecognition();
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      await screen.findByLabelText("search.voiceSearchAriaLabel");
    } finally {
      uninstall();
    }
  });

  it("requests the microphone via getUserMedia, then starts recognition with a region tag", async () => {
    const recRef = installFakeRecognition();
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    setMediaDevices(getUserMedia);
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("search.voiceSearchAriaLabel"));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }));
      await waitFor(() => expect(recRef.current?.start).toHaveBeenCalled());
      expect(stopTrack).toHaveBeenCalled();
      // A region-qualified BCP-47 tag, not the bare app locale.
      expect(recRef.current?.lang).toContain("-");
    } finally {
      uninstall();
    }
  });

  it("reports dictation through onResult", async () => {
    const recRef = installFakeRecognition();
    setMediaDevices(vi.fn().mockResolvedValue({ getTracks: () => [] }));
    const onResult = vi.fn();
    try {
      render(<VoiceSearchButton onResult={onResult} />);
      fireEvent.click(await screen.findByLabelText("search.voiceSearchAriaLabel"));
      await waitFor(() => expect(recRef.current?.start).toHaveBeenCalled());
      act(() => {
        recRef.current?.onresult?.({
          resultIndex: 0,
          results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: "berlin" } } },
        });
      });
      expect(onResult).toHaveBeenCalledWith("berlin", true);
    } finally {
      uninstall();
    }
  });

  it("surfaces a message when voice recognition errors instead of failing silently", async () => {
    const recRef = installFakeRecognition();
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("search.voiceSearchAriaLabel"));
      expect(recRef.current).not.toBeNull();
      // The browser rejects mic access: previously swallowed, now surfaced.
      act(() => recRef.current?.onerror?.({ error: "not-allowed" }));
      await screen.findByText("search.voiceErrorNotAllowed");
    } finally {
      uninstall();
    }
  });

  it("falls through to recognition when getUserMedia is rejected (non-fatal preflight)", async () => {
    // A blocked getUserMedia (e.g. Permissions-Policy) must NOT abort: plain
    // SpeechRecognition still works in that context, so recognition must start.
    const recRef = installFakeRecognition();
    setMediaDevices(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("search.voiceSearchAriaLabel"));
      await waitFor(() => expect(recRef.current?.start).toHaveBeenCalled());
    } finally {
      uninstall();
    }
  });

  it("does not start recognition if voice search is cancelled while getUserMedia is pending", async () => {
    const recRef = installFakeRecognition();
    let resolveMic: (stream: { getTracks: () => { stop: () => void }[] }) => void = () => {};
    const getUserMedia = vi.fn().mockReturnValue(
      new Promise<{ getTracks: () => { stop: () => void }[] }>((resolve) => {
        resolveMic = resolve;
      }),
    );
    setMediaDevices(getUserMedia);
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      const micButton = await screen.findByLabelText("search.voiceSearchAriaLabel");
      fireEvent.click(micButton); // start — getUserMedia now pending
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      fireEvent.click(micButton); // cancel while the preflight is still pending
      // The preflight resolves late; it must be ignored.
      await act(async () => {
        resolveMic({ getTracks: () => [{ stop: () => {} }] });
        await Promise.resolve();
      });
      expect(recRef.current).toBeNull();
    } finally {
      uninstall();
    }
  });
});

describe("VoiceSearchButton inside the installed shell", () => {
  it.each(["negotiating", "native-incompatible", "native-error", "native-compatible"] as const)(
    "hides without capability in %s",
    async (state) => {
      installFakeRecognition();
      runtime.current = {
        ...BROWSER_RUNTIME,
        state,
        handshake:
          state === "native-compatible"
            ? null
            : ({ capabilities: {} } as MobileRuntime["handshake"]),
      };
      (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };
      try {
        const { queryByLabelText } = render(<VoiceSearchButton onResult={vi.fn()} />);
        await waitFor(() => expect(queryByLabelText("search.voiceSearchAriaLabel")).toBeNull());
      } finally {
        runtime.current = null;
        delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
        uninstall();
      }
    },
  );

  function nativeRuntime() {
    const listeners = new Set<(event: NativeToWebMessage) => void>();
    const send = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue({ type: "voice.availability", payload: { available: true } });
    runtime.current = {
      ...BROWSER_RUNTIME,
      state: "native-compatible",
      isInstalledShell: true,
      client: {
        send,
        request,
        subscribe: (listener: (event: NativeToWebMessage) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      } as unknown as MobileRuntime["client"],
      handshake: { capabilities: {} } as MobileRuntime["handshake"],
    };
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };
    const emit = (state: string, text?: string, error?: string) => {
      const requestId = (send.mock.calls[0]?.[1] as { requestId: string }).requestId;
      for (const listener of listeners)
        listener({
          type: "voice.event",
          payload: { requestId, state, text, error },
        } as NativeToWebMessage);
    };
    if (!runtime.current.client) throw new Error("missing test client");
    return { send, emit, listeners, client: runtime.current.client, request };
  }

  it("stays hidden until a positive probe, and probes again for a new client or handshake", async () => {
    const h = nativeRuntime();
    let resolve!: (value: unknown) => void;
    h.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    try {
      const view = render(<VoiceSearchButton onResult={vi.fn()} />);
      expect(screen.queryByLabelText("search.voiceSearchAriaLabel")).toBeNull();
      expect(h.client.request).toHaveBeenCalledWith("voice.probe", {});
      view.rerender(<VoiceSearchButton onResult={vi.fn()} />);
      expect(h.client.request).toHaveBeenCalledTimes(1);
      await act(async () => resolve({ type: "voice.availability", payload: { available: true } }));
      await screen.findByLabelText("search.voiceSearchAriaLabel");
      const next = nativeRuntime();
      next.request.mockResolvedValue({
        type: "voice.availability",
        payload: { available: false },
      } as NativeToWebMessage);
      view.rerender(<VoiceSearchButton onResult={vi.fn()} />);
      expect(screen.queryByLabelText("search.voiceSearchAriaLabel")).toBeNull();
      await waitFor(() => expect(next.client.request).toHaveBeenCalledTimes(1));
      if (!runtime.current?.handshake) throw new Error("missing test handshake");
      runtime.current = { ...runtime.current, handshake: { ...runtime.current.handshake } };
      view.rerender(<VoiceSearchButton onResult={vi.fn()} />);
      await waitFor(() => expect(next.client.request).toHaveBeenCalledTimes(2));
    } finally {
      runtime.current = null;
      delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
    }
  });

  it("ignores a positive probe from a replaced client and never probes outside the shell", async () => {
    const old = nativeRuntime();
    let resolve!: (value: unknown) => void;
    old.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    try {
      const view = render(<VoiceSearchButton onResult={vi.fn()} />);
      const next = nativeRuntime();
      next.request.mockResolvedValue({
        type: "voice.availability",
        payload: { available: false },
      } as NativeToWebMessage);
      view.rerender(<VoiceSearchButton onResult={vi.fn()} />);
      await act(async () => resolve({ type: "voice.availability", payload: { available: true } }));
      expect(screen.queryByLabelText("search.voiceSearchAriaLabel")).toBeNull();
      next.request.mockClear();
      runtime.current = { ...(runtime.current as MobileRuntime), isInstalledShell: false };
      view.rerender(<VoiceSearchButton onResult={vi.fn()} />);
      expect(next.client.request).not.toHaveBeenCalled();
    } finally {
      runtime.current = null;
      delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
    }
  });

  it.each(["false", "timeout", "rejection"])(
    "keeps an old-APK-shaped hello hidden on probe %s",
    async (outcome) => {
      const h = nativeRuntime(); // Handshake has no voice field.
      if (outcome === "false")
        h.request.mockResolvedValue({
          type: "voice.availability",
          payload: { available: false },
        } as NativeToWebMessage);
      else h.request.mockRejectedValue(new Error(outcome));
      try {
        render(<VoiceSearchButton onResult={vi.fn()} />);
        await waitFor(() => expect(h.client.request).toHaveBeenCalledTimes(1));
        expect(screen.queryByLabelText("search.voiceSearchAriaLabel")).toBeNull();
      } finally {
        runtime.current = null;
        delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
      }
    },
  );

  it("uses native interim/final results, stop preserves final, unmount cancels without browser capture", async () => {
    const rec = installFakeRecognition();
    const capture = vi.fn();
    setMediaDevices(capture);
    const h = nativeRuntime();
    const onResult = vi.fn();
    try {
      const view = render(<VoiceSearchButton onResult={onResult} />);
      const button = await screen.findByLabelText("search.voiceSearchAriaLabel");
      fireEvent.click(button);
      expect(h.send).toHaveBeenCalledWith("voice.start", {
        requestId: expect.any(String),
        locale: expect.stringContaining("-"),
      });
      act(() => h.emit("partial", "Berlin"));
      expect(onResult).toHaveBeenLastCalledWith("Berlin", false);
      fireEvent.click(button);
      expect(h.send.mock.calls.at(-1)?.[0]).toBe("voice.stop");
      act(() => h.emit("final", "Berlin Hbf"));
      expect(onResult).toHaveBeenLastCalledWith("Berlin Hbf", true);
      view.unmount();
      expect(h.send.mock.calls.at(-1)?.[0]).toBe("voice.cancel");
      act(() => h.emit("final", "late"));
      expect(onResult).toHaveBeenCalledTimes(2);
      expect(h.listeners.size).toBe(0);
      expect(capture).not.toHaveBeenCalled();
      expect(rec.current).toBeNull();
    } finally {
      runtime.current = null;
      delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
      uninstall();
    }
  });

  it.each(
    [
      ["not-allowed", "voiceErrorNotAllowedApp"],
      ["language-not-supported", "voiceErrorLanguageApp"],
      ["audio-capture", "voiceErrorNoMicrophone"],
      ["no-speech", "voiceErrorNoSpeech"],
      ["busy", "voiceErrorGeneric"],
      ["unavailable", "voiceErrorGeneric"],
      ["aborted", "voiceErrorGeneric"],
      ["generic", "voiceErrorGeneric"],
    ].flatMap(([error, key]) => [
      [error, key, "android"],
      [error, key.endsWith("App") ? `${key}Ios` : key, "ios"],
    ]),
  )("maps native %s to %s on %s", async (error, key, platform) => {
    const h = nativeRuntime();
    if (runtime.current?.handshake)
      runtime.current.handshake.platform = platform as "ios" | "android";
    try {
      render(<VoiceSearchButton onResult={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("search.voiceSearchAriaLabel"));
      act(() => h.emit("error", undefined, error));
      await screen.findByText(`search.${key}`);
    } finally {
      runtime.current = null;
      delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
    }
  });
});
