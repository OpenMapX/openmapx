import { randomBytes } from "node:crypto";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// A mutation names its deadline in its operation key and in its request.
const deadline = Date.now() + 30 * 60_000;

function request(operationKey: string, operation: Record<string, unknown>) {
  const now = Date.now();
  return {
    version: 2,
    requestId: `ops1_${randomBytes(12).toString("base64url")}`,
    operationKey,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20_000).toISOString(),
    operation,
    execution: { requestedDeadlineAt: deadline },
  };
}

// C5: an operation key names one body; a different body under it is a conflict.
describe.skipIf(crashPointsUnavailable())("an operation key reused with another body", () => {
  let host: CrashHost;
  beforeAll(async () => {
    host = await CrashHost.open();
  }, 600_000);
  afterAll(async () => {
    await host?.close();
  }, 120_000);

  it("is refused as a conflict and starts no effect for the second body", async () => {
    const key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
    const first = await host.agentRequest(
      "POST",
      "/v1/operations",
      request(key, { kind: "service.stop", serviceId: "well-known" }),
    );
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const before = host.mark();
    const second = await host.agentRequest(
      "POST",
      "/v1/operations",
      request(key, { kind: "service.stop", serviceId: "traefik" }),
    );
    expect(second.status).toBe(409);
    expect(
      host
        .dockerEffects({ since: before })
        .filter((call) => call.args.some((value) => value.includes("traefik"))),
    ).toEqual([]);
    // The same body under the same key is the original operation, not a new one.
    const again = await host.agentRequest(
      "POST",
      "/v1/operations",
      request(key, { kind: "service.stop", serviceId: "well-known" }),
    );
    expect(again.status).toBeLessThan(300);
    expect((again.body as { result?: { operationId?: string } }).result?.operationId).toBe(
      (first.body as { result?: { operationId?: string } }).result?.operationId,
    );
  }, 600_000);
});
