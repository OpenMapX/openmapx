import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The data-manager restarts while an update holds its data fence.
crashScenario({
  title: "a data-manager restarted while its fence is held",
  name: "refuses data jobs until the update settles the fence, then admits them",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const launch = host.blockDocker({
      command: "run",
      caller: "agent",
      service: "configuration-handoff",
    });
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    await launch.entered;
    expect((await host.submitDataJob()).status).toBe(409);
    await host.kill("dm");
    await host.restart("dm");
    expect((await host.submitDataJob()).status).toBe(409);
    launch.release();
    const job = await host.waitForJob(submitted.jobId as string);
    expect(job.status).toBe("success");
    expect((await host.submitDataJob()).status).toBe(200);
  },
});
