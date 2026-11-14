import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The data-manager's answer to the fence prepare is lost.
crashScenario({
  title: "a lost data-fence prepare reply",
  name: "keeps one fence, refuses data jobs while it is held and completes the update",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
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
  },
});
