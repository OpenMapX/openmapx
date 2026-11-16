import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { pumpExport } from "./export-response.js";

describe("pumpExport", () => {
  it("ends the archive when the response closed before streaming began", async () => {
    const response = new PassThrough();
    response.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    let sink: Writable | undefined;
    const dispose = vi.fn(async () => {});
    const { delivered } = pumpExport(
      {
        filename: "export.zip",
        // Waits for the sink to fail, as the real archive writer does.
        write: (target) =>
          new Promise<void>((_resolve, reject) => {
            sink = target;
            if (target.destroyed) reject(new Error("sink closed"));
            else target.once("close", () => reject(new Error("sink closed")));
          }),
        dispose,
      },
      response,
    );
    expect(await delivered).toBe(false);
    expect(sink?.destroyed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
