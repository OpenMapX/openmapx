import { expect } from "vitest";
import { crashScenario } from "../scenario";

// An operation key names one body; a different body under it is a conflict.
crashScenario({
  title: "an operation key reused with another body",
  name: "is refused as a conflict and starts no effect for the second body",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const key = host.newOperationKey();
    const first = await host.submitAgentOperation(key, {
      kind: "service.stop",
      serviceId: "well-known",
    });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    expect(first.operationId).toBeDefined();
    const before = host.mark();
    const second = await host.submitAgentOperation(key, {
      kind: "service.stop",
      serviceId: "traefik",
    });
    expect(second.status).toBe(409);
    expect(
      host
        .dockerEffects({ since: before })
        .filter((call) => call.args.some((value) => value.includes("traefik"))),
    ).toEqual([]);
    // The same body under the same key is the original operation, not a new one.
    const again = await host.submitAgentOperation(key, {
      kind: "service.stop",
      serviceId: "well-known",
    });
    expect(again.status).toBeLessThan(300);
    expect(again.operationId).toBe(first.operationId);
  },
});
