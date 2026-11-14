import { expect } from "vitest";
import { crashScenario } from "../scenario";

// Two admissions race; exactly one proceeds.
crashScenario({
  title: "concurrent update admissions",
  name: "admits one of two simultaneous update requests and refuses the other as busy",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const start = host.mark();
    // The winner parks on its first image download.
    const download = host.blockDocker({ command: "pull", caller: "agent" });
    const [first, second] = await Promise.all([host.submitUpdate(), host.submitUpdate()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    await download.entered;
    // The loser started nothing: the only download in flight is the winner's.
    expect(host.dockerEffects({ command: "pull", caller: "agent", since: start })).toHaveLength(1);

    download.fail("Error response from daemon: connection reset");
    const job = await host.waitForJob(winner.jobId as string);
    expect(job.status).toBe("failed");

    const retry = await host.submitUpdate();
    expect(retry.status).toBe(200);
    expect(retry.jobId).not.toBe(winner.jobId);
  },
});
