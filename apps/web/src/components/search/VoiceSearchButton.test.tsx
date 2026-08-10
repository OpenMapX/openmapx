import { describe, expect, it, vi } from "vitest";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";
import { act, fireEvent, render, screen, waitFor } from "@/test";
import { VoiceSearchButton } from "./VoiceSearchButton";

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
  it("offers no microphone even where the browser would support one", async () => {
    installFakeRecognition();
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };
    try {
      const { queryByLabelText } = render(<VoiceSearchButton onResult={vi.fn()} />);
      // A store build that asks for a permission it never declared is a
      // rejection, so the control cannot exist at all.
      await waitFor(() => expect(queryByLabelText("search.voiceSearchAriaLabel")).toBeNull());
    } finally {
      delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
      uninstall();
    }
  });
});
