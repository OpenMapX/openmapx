import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestAbortBinding {
  signal: AbortSignal;
  dispose: () => void;
}

export function bindRequestAbort(
  request: FastifyRequest,
  reply: FastifyReply,
): RequestAbortBinding {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Client disconnected"));
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    request.raw.off("aborted", abort);
    reply.raw.off("close", abortClosedReply);
  };
  const abortClosedReply = () => {
    if (!reply.raw.writableEnded) abort();
    dispose();
  };

  request.raw.once("aborted", abort);
  reply.raw.once("close", abortClosedReply);
  if (request.raw.aborted || reply.raw.destroyed) {
    abort();
    dispose();
  }

  return {
    signal: controller.signal,
    dispose,
  };
}

export function withDeadline(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
