import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The registry is unreachable when the update downloads release N+1.
crashScenario({
  title: "an update during a registry outage",
  name: "fails before maintenance, keeps every service on release N and admits the next update",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const before = host.runningImages();
    const start = host.mark();
    host.registryOutage(true);
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    const job = await host.waitForJob(submitted.jobId as string);
    expect(job.status).toBe("failed");

    // Nothing was recreated or started and no helper was launched.
    expect(host.runningImages()).toEqual(before);
    expect(host.dockerEffects({ command: "compose up", since: start })).toEqual([]);
    expect(host.dockerEffects({ command: "run", caller: "agent", since: start })).toEqual([]);
    // No maintenance held data admission or targets.
    expect((await host.submitDataJob()).status).toBe(200);

    host.registryOutage(false);
    const retry = await host.submitUpdate();
    expect(retry.status).toBe(200);
    expect(retry.jobId).not.toBe(submitted.jobId);
  },
});
