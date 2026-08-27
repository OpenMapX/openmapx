import { createFatalProcessHandler } from "@openmapx/core/server";
import { describe, expect, it, vi } from "vitest";

describe("fatal process policy", () => {
  it.each([
    Object.assign(new Error("double send"), { code: "ERR_HTTP_HEADERS_SENT" }),
    Object.assign(new Error("parser assertion"), {
      code: "ERR_ASSERTION",
      stack: "Error: parser assertion\n at undici/lib/dispatcher/client-h1.js",
    }),
    new Error("unknown uncaught failure"),
    "non-error rejection",
  ])("logs and terminates for every uncaught value %#", (failure) => {
    const fatal = vi.fn();
    const exit = vi.fn();
    const handler = createFatalProcessHandler({ fatal, exit });

    handler(failure);

    expect(fatal).toHaveBeenCalledWith({ err: failure }, "Fatal uncaught error — exiting");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
