import { describe, expect, it, vi } from "vitest";
import { createIntegrationLogger } from "../utils/integration-logger";

describe("createIntegrationLogger", () => {
  it("captures Error argument as `err` binding so pino serializes it", () => {
    const error = vi.fn();
    const fakeFastify = {
      log: { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() },
    } as never;

    const log = createIntegrationLogger("test-int", fakeFastify);
    const boom = new Error("upstream timeout");
    log.error("upstream call failed", boom);

    expect(error).toHaveBeenCalledTimes(1);
    const [bindings, msg] = error.mock.calls[0];
    expect(bindings).toMatchObject({ integration: "test-int", err: boom });
    expect(msg).toBe("upstream call failed");
  });

  it("preserves message-only calls", () => {
    const info = vi.fn();
    const fakeFastify = {
      log: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never;
    const log = createIntegrationLogger("x", fakeFastify);
    log.info("hello");
    expect(info).toHaveBeenCalledWith({ integration: "x" }, "hello");
  });

  it("captures Error even when other printf args are present", () => {
    const warn = vi.fn();
    const fakeFastify = { log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } } as never;
    const log = createIntegrationLogger("y", fakeFastify);
    const boom = new Error("nope");
    log.warn("failed for %s", "berlin", boom);
    expect(warn).toHaveBeenCalledTimes(1);
    const [bindings, msg, arg] = warn.mock.calls[0];
    expect(bindings).toMatchObject({ integration: "y", err: boom });
    expect(msg).toBe("failed for %s");
    expect(arg).toBe("berlin");
  });
});
