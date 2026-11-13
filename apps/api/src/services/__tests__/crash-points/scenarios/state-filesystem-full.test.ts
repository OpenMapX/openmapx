import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The agent's state filesystem fills up right after an effect started.
describe.skipIf(
  process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" ||
    !!crashPointsUnavailable() ||
    process.env.OPENMAPX_RUN_CRASH_DISK_TESTS !== "1",
)("an agent whose state filesystem is full after an effect", () => {
  let host: CrashHost;
  beforeAll(async () => {
    host = await CrashHost.open({ smallStateFilesystem: true });
  }, 600_000);
  afterAll(async () => {
    await host?.close();
  }, 120_000);

  scenario(
    "never reports success, never repeats the effect and says why if it cannot start",
    async () => {
      const appWeb = host.containerId("app-web");
      const effect = host.blockDocker({ command: "effect", caller: "agent", contains: appWeb });
      const stopped = await host.serviceAction("app-web", "stop");
      expect(stopped.status).toBe(200);
      const entered = await effect.entered;
      host.fillStateFilesystem();
      effect.release();
      const job = await host.settledJob(stopped.jobId as string, 90_000);
      expect(job.status).not.toBe("success");
      const [operation] = host.agentOperations("service.stop");
      host.freeStateFilesystem();
      await host.kill("agent");
      const restarted = await host.restart("agent").then(
        () => true,
        () => false,
      );
      if (!restarted) {
        // An agent that cannot start says why.
        expect(host.logs("agent")).toMatch(/ops-agent failed to start: \S/);
        return;
      }
      if (operation) {
        const state = (await host.operation(operation.operationId)).state;
        expect(state).not.toBe("succeeded");
      }
      expect(host.dockerEffects({ caller: "agent", contains: appWeb, since: entered.seq })).toEqual(
        [],
      );
    },
    600_000,
  );
});
