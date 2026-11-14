import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The configuration helper dies between recreating data-manager and app-api.
crashScenario({
  title: "an update whose helper is killed mid-recreate",
  name: "is not re-run, recreates nothing more, never succeeds and holds further updates",
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
    expect(await host.killHelpers()).toBe(1);
    const killedAt = host.mark();
    // The helper's Compose client died with it: the recreate never happens.
    apiRecreate.fail("context canceled");
    const job = await host.settledJob(submitted.jobId as string, 120_000);
    expect(job.status).not.toBe("success");
    expect(host.dockerEffects({ caller: "helper", since: killedAt })).toEqual([]);
    expect(host.dockerEffects({ command: "run", caller: "agent", since: killedAt })).toEqual([]);
    const recreated = host
      .dockerEffects({ command: "compose up", caller: "helper", since: start })
      .filter((call) => call.code === 0)
      .map((call) => call.args.at(-1));
    expect(recreated).not.toContain("app-api");
    expect(recreated).not.toContain("ops-agent");
    expect(host.runningImages()["app-api"]).toBe(host.releaseImageId("current", "api"));
    expect((await host.submitUpdate()).status).toBe(409);
  },
});
