import { expect } from "vitest";
import type { DataManagerCaller } from "../driver";
import { crashScenario } from "../scenario";

const MAINTENANCE = "00000000-0000-4000-8000-000000000000";
const FENCE: [string, string][] = [
  ["POST", "/executions/configuration-maintenance/prepare"],
  ["POST", "/executions/configuration-maintenance/recovery"],
  ["GET", `/executions/configuration-maintenance/${MAINTENANCE}`],
  ["POST", `/executions/configuration-maintenance/${MAINTENANCE}/settle`],
];
const AGENT_RECEIVERS: [string, string][] = [
  ...FENCE,
  ["POST", "/executions/generation-hardlinks"],
  ["POST", "/executions/generation-hardlinks/recovery"],
];
const API_ONLY: [string, string][] = [
  ["POST", "/ambient-places/build"],
  ["POST", "/offline/packages/prepare"],
  ["POST", "/transit/restart-motis"],
  ["GET", "/transit/pins"],
  ["GET", "/coverage/evidence"],
];

// Each caller holds its own data-manager token and reaches only its routes.
crashScenario({
  title: "data-manager routes called with another caller's token",
  name: "are refused with 403 and change nothing",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const start = host.mark();
    const refusals: [DataManagerCaller, [string, string][]][] = [
      ["api", AGENT_RECEIVERS],
      ["host-cli", FENCE],
      ["ops-agent", API_ONLY],
    ];
    for (const [caller, routes] of refusals)
      for (const [method, path] of routes) {
        const reply = await host.callDataManager(
          caller,
          method,
          path,
          method === "GET" ? undefined : {},
        );
        expect({ caller, method, path, status: reply.status, body: reply.body }).toEqual({
          caller,
          method,
          path,
          status: 403,
          body: { error: "This caller may not use this route" },
        });
      }
    // Nothing was started or fenced: no Docker effect, an update still
    // completes and data jobs are admitted after it.
    expect(host.dockerEffects({ since: start })).toEqual([]);
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    expect((await host.waitForJob(submitted.jobId as string)).status).toBe("success");
    expect((await host.submitDataJob()).status).toBe(200);
  },
});
