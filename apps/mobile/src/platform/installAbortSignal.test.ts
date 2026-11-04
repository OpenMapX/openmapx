import { installAbortSignal } from "./installAbortSignal";

class BareSignal {
  aborted = false;
  reason?: unknown;
}
type Throwing = BareSignal & { throwIfAborted(): void };

describe("installAbortSignal", () => {
  it("adds throwIfAborted to a signal class without it", () => {
    installAbortSignal(BareSignal);
    const signal = new BareSignal() as Throwing;
    expect(() => signal.throwIfAborted()).not.toThrow();
    signal.aborted = true;
    expect(() => signal.throwIfAborted()).toThrow(expect.objectContaining({ name: "AbortError" }));
    const reason = new Error("timeout");
    signal.reason = reason;
    expect(() => signal.throwIfAborted()).toThrow(reason);
  });

  it("keeps an existing implementation", () => {
    const own = () => undefined;
    class Native {
      throwIfAborted = own;
    }
    Object.defineProperty(Native.prototype, "throwIfAborted", { value: own });
    installAbortSignal(Native);
    expect(Native.prototype.throwIfAborted).toBe(own);
  });
});
