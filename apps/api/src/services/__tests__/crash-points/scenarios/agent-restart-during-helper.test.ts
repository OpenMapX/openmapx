import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The agent is killed and restarted while its helper replaces services.
crashScenario({
  title: "an agent restarted while the helper runs",
  name: "lets the helper finish, observes its result and is recreated last",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const start = host.mark();
    const apiRecreate = host.blockDocker({
      command: "compose up",
      caller: "helper",
      service: "app-api",
    });
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    await apiRecreate.entered;
    await host.kill("agent");
    await host.restart("agent");
    apiRecreate.release();
    const job = await host.waitForJob(submitted.jobId as string);
    expect(job.status).toBe("success");
    const recreated = host
      .dockerEffects({ command: "compose up", caller: "helper", since: start })
      .map((call) => call.args.at(-1));
    expect(recreated.at(-1)).toBe("ops-agent");
    expect(new Set(recreated).size).toBe(recreated.length);
    expect(host.runningImages()["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
    expect(host.runningImages()["app-api"]).toBe(host.releaseImageId("next", "api"));
  },
});
