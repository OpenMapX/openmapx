import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable, type DataManagerCaller } from "../driver";
import { scenario } from "../scenario";

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
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "data-manager routes called with another caller's token",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "are refused with 403 and change nothing",
      async () => {
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
      600_000,
    );
  },
);
