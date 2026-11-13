import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The reference run every failure scenario is compared with.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a self-update",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "moves every role to release N+1 and recreates the agent last",
      async () => {
        const start = host.mark();
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        const job = await host.waitForJob(submitted.jobId as string);
        expect(job.status).toBe("success");
        const images = host.runningImages();
        expect(images["app-api"]).toBe(host.releaseImageId("next", "api"));
        expect(images["data-manager"]).toBe(host.releaseImageId("next", "data-manager"));
        expect(images["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
        const recreated = host
          .dockerEffects({ command: "compose up", caller: "helper", since: start })
          .map((call) => call.args.at(-1));
        expect(recreated.at(-1)).toBe("ops-agent");
        expect(new Set(recreated).size).toBe(recreated.length);
        // The installation is usable afterwards: data jobs are admitted again.
        expect((await host.submitDataJob()).status).toBe(200);
      },
      600_000,
    );
  },
);
