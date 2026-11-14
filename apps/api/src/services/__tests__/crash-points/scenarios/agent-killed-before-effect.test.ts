import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The agent accepted an operation and dies before its first effect.
crashScenario({
  title: "an agent killed before an accepted operation's effect",
  name: "never dispatches the operation again and never reports it succeeded",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const start = host.mark();
    // The image download's first, read-only step: the platform probe.
    const probe = host.blockDocker({ command: "info", caller: "agent", contains: "OSType" });
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    await probe.entered;
    const [download] = host.agentOperations("release.images.pull");
    expect(download).toBeDefined();
    await host.kill("agent");
    const killedAt = host.mark();
    probe.release();
    await host.restart("agent");

    const job = await host.settledJob(submitted.jobId as string, 60_000);
    const operation = await host.operation(download?.operationId as string);
    // Failed without an effect, or held for the operator; never succeeded.
    expect(job.status).not.toBe("success");
    expect(["failed", "recovery_required"]).toContain(operation.state);
    if (!job.terminal) {
      // Held and visible: the unfinished update keeps a new one out.
      expect((await host.submitUpdate()).status).toBe(409);
    }
    // Nothing of the download ran after the agent came back, and nothing changed.
    expect(host.dockerCalls({ command: "info", contains: "OSType", since: killedAt })).toEqual([]);
    expect(host.dockerEffects({ caller: "agent", since: start })).toEqual([]);
    expect(host.dockerEffects({ caller: "helper", since: start })).toEqual([]);
  },
});
