import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The data-manager's answer to the fence settle is lost.
crashScenario({
  title: "a lost data-fence settle reply",
  name: "settles idempotently, reopens data admission and completes the update",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
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
  },
});
