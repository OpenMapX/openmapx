import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The update is cancelled while its data-fence settle is on the way.
crashScenario({
  title: "an update cancelled during the fence settle",
  name: "begins no new effect, lets the settle finish and then reopens data admission",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
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
  },
});
