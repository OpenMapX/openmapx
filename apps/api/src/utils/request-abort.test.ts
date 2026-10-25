import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRequestAbort, withDeadline } from "./request-abort.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bindRequestAbort", () => {
  it("aborts on a client disconnect and removes both listeners on disposal", () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const replyRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const binding = bindRequestAbort(
      { raw: requestRaw } as unknown as FastifyRequest,
      { raw: replyRaw } as unknown as FastifyReply,
    );

    requestRaw.emit("aborted");

    expect(binding.signal.aborted).toBe(true);
    binding.dispose();
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(replyRaw.listenerCount("close")).toBe(0);
  });

  it("keeps cancellation active until the response closes and then removes both listeners", () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const replyRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const binding = bindRequestAbort(
      { raw: requestRaw } as unknown as FastifyRequest,
      { raw: replyRaw } as unknown as FastifyReply,
    );

    replyRaw.emit("close");

    expect(binding.signal.aborted).toBe(true);
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(replyRaw.listenerCount("close")).toBe(0);
  });

  it("combines caller cancellation with the requested finite deadline", () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const caller = new AbortController();

    const signal = withDeadline(caller.signal, 1_234);
    deadline.abort(new Error("deadline exceeded"));

    expect(timeout).toHaveBeenCalledWith(1_234);
    expect(signal.aborted).toBe(true);
  });
});
