import { afterEach, describe, expect, it, vi } from "vitest";
import { runInIntegrationScope } from "../integration-scope";
import { processLogger } from "../process-logger";
import { createIntegrationLogger } from "../utils/integration-logger";

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

  it("names the integration whose code is running", () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    runInIntegrationScope({ integrationId: "demo", isBuiltIn: false, revoked: false }, () =>
      processLogger.child({ reqId: "r1" }).warn("Inside the integration"),
    );
    processLogger.warn("Outside any integration");

    const [inside, outside] = written.map((line) => JSON.parse(line));
    expect(inside).toMatchObject({ integrationId: "demo", msg: "Inside the integration" });
    expect(outside).not.toHaveProperty("integrationId");
  });

  it("names the integration once in a line the integration's own logger writes", () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const log = createIntegrationLogger("demo", { log: processLogger } as never);

    runInIntegrationScope({ integrationId: "demo", isBuiltIn: false, revoked: false }, () =>
      log.warn("Through ctx.log"),
    );

    const [line] = written.map((chunk) => JSON.parse(chunk));
    expect(line).toMatchObject({ integration: "demo", msg: "Through ctx.log" });
    expect(line).not.toHaveProperty("integrationId");
  });
});
