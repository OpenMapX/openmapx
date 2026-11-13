import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// An operator runs host lifecycle commands while the helper replaces services.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "host lifecycle commands while the helper runs",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "exit busy without a Compose effect and succeed after the update",
      async () => {
        const apiRecreate = host.blockDocker({
          command: "compose up",
          caller: "helper",
          service: "app-api",
        });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await apiRecreate.entered;
        for (const action of ["start", "restart"]) {
          const before = host.mark();
          const cli = await host.cli(["services", action, "app-web"]);
          expect(cli.code, `services ${action}: ${cli.stderr}`).not.toBe(0);
          expect(host.dockerEffects({ caller: "host-cli", since: before })).toEqual([]);
        }
        apiRecreate.release();
        const job = await host.waitForJob(submitted.jobId as string);
        expect(job.status).toBe("success");
        for (const action of ["start", "restart"]) {
          const cli = await host.cli(["services", action, "app-web"]);
          expect(cli.code, `services ${action}: ${cli.stderr}`).toBe(0);
        }
      },
      600_000,
    );
  },
);
