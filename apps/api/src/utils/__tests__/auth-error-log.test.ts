import { describe, expect, it } from "vitest";
import { safeAuthErrorEvent } from "../auth-error-log.js";

const AUTH_CODE = "authorization-code-sentinel-xyz";
const TOKEN = "osm-access-token-sentinel";

describe("safeAuthErrorEvent", () => {
  it("reduces an error to class, request id and method", () => {
    const event = safeAuthErrorEvent(new TypeError("boom"), "req-1", "POST");
    expect(event).toEqual({
      event: "auth_handler_failed",
      requestId: "req-1",
      method: "POST",
      errorClass: "TypeError",
    });
  });

  it("keeps a stable machine code", () => {
    const error = Object.assign(new Error("nope"), { code: "INVALID_GRANT" });
    expect(safeAuthErrorEvent(error, "req-2", "GET").errorCode).toBe("INVALID_GRANT");
  });

  it("drops a code-shaped value that could be a credential", () => {
    for (const code of [AUTH_CODE, TOKEN, "a".repeat(200), 42, { nested: TOKEN }]) {
      const error = Object.assign(new Error("nope"), { code });
      expect(safeAuthErrorEvent(error, "req-3", "GET").errorCode).toBeUndefined();
    }
  });

  it("never serializes the thrown object's message, tokens or response", () => {
    const error = Object.assign(new Error(`failed exchanging ${AUTH_CODE}`), {
      access_token: TOKEN,
      response: { body: TOKEN },
      config: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const serialized = JSON.stringify(safeAuthErrorEvent(error, "req-4", "POST"));
    expect(serialized).not.toContain(AUTH_CODE);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("Bearer");
  });

  it("handles a non-Error throw", () => {
    expect(safeAuthErrorEvent(TOKEN, "req-5", "GET")).toEqual({
      event: "auth_handler_failed",
      requestId: "req-5",
      method: "GET",
      errorClass: "string",
    });
  });
});
