import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// An update is inside maintenance (its data fence
// is prepared and its targets are held) while the helper launch is pending.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an update holding maintenance",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "refuses data jobs and host starts, also across a data-manager restart",
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
        const before = host.mark();
        const cli = await host.cli(["services", "start", "app-web"]);
        expect(cli.code).not.toBe(0);
        expect(host.dockerEffects({ caller: "host-cli", since: before })).toEqual([]);

        await host.kill("dm");
        await host.restart("dm");
        expect((await host.submitDataJob()).status).toBe(409);

        // The helper never starts. The update does not succeed and starts nothing.
        launch.fail("docker: Error response from daemon: failed to create task");
        const job = await host
          .waitForJob(submitted.jobId as string, { timeoutMs: 90_000 })
          .catch(() => host.job(submitted.jobId as string));
        expect(job.status).not.toBe("success");
        expect(host.dockerEffects({ caller: "helper", since: before })).toEqual([]);
        expect(host.dockerEffects({ command: "compose", since: before })).toEqual([]);
        if (!job.terminal) {
          // Held and visible: maintenance still blocks data jobs and new updates.
          expect((await host.submitDataJob()).status).toBe(409);
          expect((await host.submitUpdate()).status).toBe(409);
        }
      },
      600_000,
    );
  },
);
