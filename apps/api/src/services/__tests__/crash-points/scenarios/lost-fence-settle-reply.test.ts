import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// The data-manager's answer to the fence settle is lost.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a lost data-fence settle reply",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    it("settles idempotently, reopens data admission and completes the update", async () => {
      const lost = host.dropReply("agent->dm", {
        method: "POST",
        path: /\/configuration-maintenance\/[^/]+\/settle$/,
      });
      const submitted = await host.submitUpdate();
      expect(submitted.status).toBe(200);
      await lost;
      const job = await host.waitForJob(submitted.jobId as string);
      expect(job.status).toBe("success");
      expect((await host.submitDataJob()).status).toBe(200);
    }, 600_000);
  },
);
