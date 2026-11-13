import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// The API's new image starts but never becomes healthy.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an update whose API image is unhealthy",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    it("stops before the agent, never succeeds, never rolls back and holds further updates", async () => {
      const start = host.mark();
      host.unhealthyAfterRecreate("app-api");
      const submitted = await host.submitUpdate();
      expect(submitted.status).toBe(200);
      const job = await host.settledJob(submitted.jobId as string, 180_000);
      expect(job.status).not.toBe("success");
      const recreated = host
        .dockerEffects({ command: "compose up", caller: "helper", since: start })
        .map((call) => call.args.at(-1));
      // The agent is recreated last; it is not replaced after a failed service.
      expect(recreated).not.toContain("ops-agent");
      // No automatic rollback: the API was recreated once.
      expect(recreated.filter((service) => service === "app-api")).toHaveLength(1);
      expect(host.runningImages()["ops-agent"]).toBe(host.releaseImageId("current", "ops-agent"));
      // Held and visible until the operator resolves it.
      expect((await host.submitUpdate()).status).toBe(409);
    }, 600_000);
  },
);
