import type { NativeToWebMessage } from "@openmapx/core/navigation";
import { describe, expect, it, vi } from "vitest";
import { NativeVoiceInput } from "./nativeVoiceInput";

function harness() {
  const listeners = new Set<(message: NativeToWebMessage) => void>();
  const send = vi.fn();
  const input = new NativeVoiceInput({
    send,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const callbacks = { onPartial: vi.fn(), onFinal: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  const emit = (requestId: string, state: string, text?: string, error?: string) => {
    const message = {
      type: "voice.event",
      payload: { requestId, state, text, error },
    } as NativeToWebMessage;
    for (const listener of listeners) listener(message);
  };
  const id = () => (send.mock.calls.at(-1)?.[1] as { requestId: string }).requestId;
  return { input, callbacks, emit, id, send, listeners };
}

describe("NativeVoiceInput", () => {
  it("keeps results after stop, filters foreign events and cleans up on end", () => {
    const h = harness();
    h.input.start("de-DE", h.callbacks);
    const id = h.id();
    h.emit("foreign", "final", "wrong");
    h.emit(id, "partial", "Berlin");
    h.input.stop();
    expect(h.send).toHaveBeenLastCalledWith("voice.stop", { requestId: id });
    h.emit(id, "final", "Berlin Hbf");
    h.emit(id, "ended");
    h.emit(id, "final", "late");
    expect(h.callbacks.onPartial).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onPartial).toHaveBeenCalledWith("Berlin");
    expect(h.callbacks.onFinal).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onFinal).toHaveBeenCalledWith("Berlin Hbf");
    expect(h.callbacks.onEnd).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it("cancels on replacement, uses a fresh id, discards late events and unsubscribes", () => {
    const h = harness();
    h.input.start("en-US", h.callbacks);
    const old = h.id();
    h.input.start("de-DE", h.callbacks);
    const current = h.id();
    expect(current).not.toBe(old);
    expect(h.send).toHaveBeenCalledWith("voice.cancel", { requestId: old });
    h.emit(old, "final", "old");
    h.input.cancel();
    h.emit(current, "final", "late");
    expect(h.callbacks.onFinal).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });

  it("ends on error and releases a subscription if sending fails", () => {
    const h = harness();
    h.input.start("en-US", h.callbacks);
    h.emit(h.id(), "error", undefined, "busy");
    expect(h.callbacks.onError).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onError).toHaveBeenCalledWith("busy");
    expect(h.listeners.size).toBe(0);
    h.send.mockImplementation(() => {
      throw new Error("closed");
    });
    h.input.start("en-US", h.callbacks);
    expect(h.callbacks.onError).toHaveBeenLastCalledWith("generic");
    expect(h.listeners.size).toBe(0);
  });
});
