import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The API dies while its update job waits on the image download.
crashScenario({
  title: "an API killed during an update",
  name: "reclaims the job, reuses its operations and finishes as an unkilled update",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 900_000,
  run: async (host) => {
    const download = host.blockDocker({ command: "pull", caller: "agent" });
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    await download.entered;
    await host.kill("api");
    await host.restart("api");
    download.release();
    // The restarted API resumes the job once the dead owner's claim has lapsed.
    const job = await host.waitForJob(submitted.jobId as string, { timeoutMs: 300_000 });
    expect(job.status).toBe("success");
    // The restarted API asked again under the same keys: one operation each.
    expect(host.agentOperations("release.images.pull")).toHaveLength(1);
    expect(host.agentOperations("configurationMaintenance.prepare")).toHaveLength(1);
    const pulls = host
      .dockerEffects({ command: "pull", caller: "agent" })
      .map((call) => call.args.at(-1));
    expect(new Set(pulls).size).toBe(pulls.length);
    expect(host.runningImages()["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
  },
});
