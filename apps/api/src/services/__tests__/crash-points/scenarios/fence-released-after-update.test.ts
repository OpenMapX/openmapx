import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The data-manager restarts while an update holds its data fence.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a data-manager restarted while its fence is held",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "refuses data jobs until the update settles the fence, then admits them",
      async () => {
        const launch = host.blockDocker({
          command: "run",
          caller: "agent",
          service: "configuration-handoff",
        });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await launch.entered;
        expect((await host.submitDataJob()).status).toBe(409);
        await host.kill("dm");
        await host.restart("dm");
        expect((await host.submitDataJob()).status).toBe(409);
        launch.release();
        const job = await host.waitForJob(submitted.jobId as string);
        expect(job.status).toBe("success");
        expect((await host.submitDataJob()).status).toBe(200);
      },
      600_000,
    );
  },
);
