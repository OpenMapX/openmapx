import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The agent dies while a Compose effect it started is in flight.
crashScenario({
  title: "an agent killed while its service start is in flight",
  name: "never starts the service a second time and keeps the target held",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const stopped = await host.serviceAction("app-web", "stop");
    expect(stopped.status).toBe(200);
    expect((await host.waitForJob(stopped.jobId as string)).status).toBe("success");

    const start = host.mark();
    const effect = host.blockDocker({
      command: "compose",
      caller: "agent",
      service: "app-web",
    });
    const started = await host.serviceAction("app-web", "start");
    expect(started.status).toBe(200);
    await Promise.race([
      effect.entered,
      host.waitForJob(started.jobId as string).then((job) => {
        throw new Error(`The start ended before its Compose effect: ${JSON.stringify(job)}`);
      }),
    ]);
    await host.kill("agent");
    // The engine finishes the in-flight call, as a daemon finishes a request
    // whose client went away.
    effect.release();
    await host.restart("agent");

    const job = await host.waitForJob(started.jobId as string, {
      until: (view) => view.terminal || view.status === "cancel_pending",
    });
    expect(job.status).not.toBe("success");
    // Exactly one Compose effect on app-web: the one in flight when the agent died.
    expect(
      host.dockerEffects({ command: "compose", service: "app-web", since: start }),
    ).toHaveLength(1);

    // The target stays held: a host start is refused and changes nothing.
    const before = host.mark();
    const cli = await host.cli(["services", "start", "app-web"]);
    expect(cli.code).not.toBe(0);
    expect(host.dockerEffects({ command: "compose", since: before })).toEqual([]);
  },
});
