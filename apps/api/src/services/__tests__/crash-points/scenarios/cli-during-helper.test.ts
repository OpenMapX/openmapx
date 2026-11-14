import { expect } from "vitest";
import { crashScenario } from "../scenario";

// An operator runs host lifecycle commands while the helper replaces services.
crashScenario({
  title: "host lifecycle commands while the helper runs",
  name: "exit busy without a Compose effect and succeed after the update",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 600_000,
  run: async (host) => {
    const apiRecreate = host.blockDocker({
      command: "compose up",
      caller: "helper",
      service: "app-api",
    });
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    await apiRecreate.entered;
    for (const action of ["start", "restart"]) {
      const before = host.mark();
      const cli = await host.cli(["services", action, "app-web"]);
      expect(cli.code, `services ${action}: ${cli.stderr}`).not.toBe(0);
      expect(host.dockerEffects({ caller: "host-cli", since: before })).toEqual([]);
    }
    apiRecreate.release();
    const job = await host.waitForJob(submitted.jobId as string);
    expect(job.status).toBe("success");
    for (const action of ["start", "restart"]) {
      const cli = await host.cli(["services", action, "app-web"]);
      expect(cli.code, `services ${action}: ${cli.stderr}`).toBe(0);
    }
  },
});
