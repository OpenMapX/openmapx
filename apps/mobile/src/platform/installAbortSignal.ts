/**
 * Gives React Native's `AbortSignal` the `throwIfAborted()` method it lacks.
 *
 * The shared API client calls `signal.throwIfAborted()` after reading a
 * response, so without it every directions, reroute and transit refresh
 * request from the shell fails with "undefined is not a function". A runtime
 * that already has the method keeps it.
 */
export function installAbortSignal(
  ctor: { prototype: object } | undefined = globalThis.AbortSignal,
): void {
  if (!ctor) return;
  const prototype = ctor.prototype as { throwIfAborted?: unknown };
  if (typeof prototype.throwIfAborted === "function") return;
  Object.defineProperty(prototype, "throwIfAborted", {
    configurable: true,
    writable: true,
    value(this: { aborted: boolean; reason?: unknown }) {
      if (!this.aborted) return;
      if (this.reason !== undefined) throw this.reason;
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  });
}

installAbortSignal();
