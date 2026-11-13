import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

// C1: two admissions race; exactly one proceeds.
describe.skipIf(crashPointsUnavailable())("concurrent update admissions", () => {
  let host: CrashHost;
  beforeAll(async () => {
    host = await CrashHost.open();
  }, 600_000);
  afterAll(async () => {
    await host?.close();
  }, 120_000);

  it("admits one of two simultaneous update requests and refuses the other as busy", async () => {
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
  }, 600_000);
});
