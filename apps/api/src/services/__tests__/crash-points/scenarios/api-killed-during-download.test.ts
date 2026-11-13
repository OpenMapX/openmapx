import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The API dies while its update job waits on the image download.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an API killed during an update",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "reclaims the job, reuses its operations and finishes as an unkilled update",
      async () => {
        const download = host.blockDocker({ command: "pull", caller: "agent" });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await download.entered;
        await host.kill("api");
        await host.restart("api");
        download.release();
        // The restarted API resumes the job once the dead owner's claim has lapsed.
        const job = await host.waitForJob(submitted.jobId as string, { timeoutMs: 300_000 });
        expect(job.status).toBe("success");
        // The restarted API asked again under the same keys: one operation each.
        expect(host.agentOperations("release.images.pull")).toHaveLength(1);
        expect(host.agentOperations("configurationMaintenance.prepare")).toHaveLength(1);
        const pulls = host
          .dockerEffects({ command: "pull", caller: "agent" })
          .map((call) => call.args.at(-1));
        expect(new Set(pulls).size).toBe(pulls.length);
        expect(host.runningImages()["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
      },
      900_000,
    );
  },
);
