import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// The data-manager's answer to the fence prepare is lost.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a lost data-fence prepare reply",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    it("keeps one fence, refuses data jobs while it is held and completes the update", async () => {
      const lost = host.dropReply("agent->dm", {
        method: "POST",
        path: /\/configuration-maintenance\/prepare$/,
      });
      const submitted = await host.submitUpdate();
      expect(submitted.status).toBe(200);
      await lost;
      expect((await host.submitDataJob()).status).toBe(409);
      const job = await host.waitForJob(submitted.jobId as string);
      expect(job.status).toBe("success");
      expect(host.agentOperations("configurationMaintenance.prepare")).toHaveLength(1);
      expect((await host.submitDataJob()).status).toBe(200);
    }, 600_000);
  },
);
