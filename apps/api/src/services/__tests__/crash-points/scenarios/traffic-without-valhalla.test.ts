import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// OpenConditions is configured, so the data-manager's traffic jobs run, but
// the host runs no Valhalla for them to maintain.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "traffic maintenance on a host without Valhalla",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open({ openConditions: true });
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "changes nothing, holds no target and still admits an update",
      async () => {
        await host.waitUntil(
          async () =>
            host
              .requests("dm->agent")
              .some(
                (request) =>
                  request.kind === "valhalla.traffic.maintain" && (request.status ?? 500) < 300,
              ),
          180_000,
          "the data-manager to request traffic maintenance",
        );
        expect(host.dockerEffects({ caller: "agent", contains: "valhalla" })).toEqual([]);
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        expect((await host.waitForJob(submitted.jobId as string)).status).toBe("success");
      },
      600_000,
    );
  },
);
