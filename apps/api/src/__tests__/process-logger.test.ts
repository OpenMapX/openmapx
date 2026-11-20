import { afterEach, describe, expect, it, vi } from "vitest";
import { processLogger } from "../process-logger";

afterEach(() => vi.restoreAllMocks());

describe("process logger", () => {
  it("redacts a credential in a raw error's URL before it reaches stdout", () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    processLogger.info(
      {
        component: "test",
        err: new Error("GET https://user:hunter2@provider.example/v1?api_key=s3cr3t failed"),
      },
      "Upstream request failed",
    );

    const output = written.join("");
    expect(output).toContain("Upstream request failed");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("s3cr3t");
  });
});
