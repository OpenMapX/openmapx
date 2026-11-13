import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The update is cancelled while the helper's recreate of app-api is in flight.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an update cancelled during a recreate",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "finishes the recreate in flight, starts no further effect and never succeeds",
      async () => {
        const start = host.mark();
        const apiRecreate = host.blockDocker({
          command: "compose up",
          caller: "helper",
          service: "app-api",
        });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await apiRecreate.entered;
        const cancelled = await host.cancelJob(submitted.jobId as string);
        expect(cancelled.status).toBeLessThan(500);
        const releasedAt = host.mark();
        apiRecreate.release();
        const job = await host.settledJob(submitted.jobId as string, 120_000);
        expect(job.status).not.toBe("success");
        // The recreate in flight completed once; nothing after it began.
        const recreated = host
          .dockerEffects({ command: "compose up", caller: "helper", since: start })
          .map((call) => call.args.at(-1));
        expect(recreated.filter((service) => service === "app-api")).toHaveLength(1);
        expect(
          host
            .dockerEffects({ command: "compose up", since: releasedAt })
            .map((call) => call.args.at(-1)),
        ).not.toContain("ops-agent");
        expect(host.dockerEffects({ command: "run", caller: "agent", since: releasedAt })).toEqual(
          [],
        );
        // Targets are released only once the effect in flight ended, and an
        // unfinished update keeps a new one out.
        if (!job.terminal) expect((await host.submitUpdate()).status).toBe(409);
      },
      600_000,
    );
  },
);
