import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// The update is cancelled while its data-fence settle is on the way.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an update cancelled during the fence settle",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    it("begins no new effect, lets the settle finish and then reopens data admission", async () => {
      const settle = host.holdRequest("agent->dm", {
        method: "POST",
        path: /\/configuration-maintenance\/[^/]+\/settle$/,
      });
      const submitted = await host.submitUpdate();
      expect(submitted.status).toBe(200);
      await settle.entered;
      const cancelled = await host.cancelJob(submitted.jobId as string);
      expect(cancelled.status).toBeLessThan(500);
      const cancelledAt = host.mark();
      settle.forward();
      const job = await host.settledJob(submitted.jobId as string, 120_000);
      expect(host.dockerEffects({ since: cancelledAt })).toEqual([]);
      if (job.terminal) expect((await host.submitDataJob()).status).toBe(200);
      else expect((await host.submitUpdate()).status).toBe(409);
    }, 600_000);
  },
);
