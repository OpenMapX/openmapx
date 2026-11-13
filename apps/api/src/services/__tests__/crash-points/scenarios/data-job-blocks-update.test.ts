import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// A long data job runs when an update is requested.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an update requested while a data job runs",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "is refused before maintenance and admitted once the data job ended",
      async () => {
        await host.startLongDataJob();
        const start = host.mark();
        const submitted = await host.submitUpdate();
        if (submitted.status === 200) {
          const job = await host.settledJob(submitted.jobId as string, 120_000);
          expect(job.status).not.toBe("success");
        } else expect(submitted.status).toBe(409);
        expect(host.dockerEffects({ command: "run", caller: "agent", since: start })).toEqual([]);
        expect(host.dockerEffects({ command: "compose", since: start })).toEqual([]);
        host.finishLongDataJob();
        await host.waitUntil(
          async () => (await host.submitDataJob()).status === 200,
          180_000,
          "the data job to end",
        );
        // The refused update either waited and now completes, ended and a new
        // request completes, or is held for the operator and keeps others out.
        const first =
          submitted.status === 200
            ? await host.settledJob(submitted.jobId as string, 240_000)
            : undefined;
        if (first && !first.terminal) {
          expect((await host.submitUpdate()).status).toBe(409);
          expect(host.dockerEffects({ command: "run", caller: "agent", since: start })).toEqual([]);
          expect(host.dockerEffects({ command: "compose", since: start })).toEqual([]);
          return;
        }
        if (first?.status !== "success") {
          const retry = await host.submitUpdate();
          expect(retry.status).toBe(200);
          expect((await host.waitForJob(retry.jobId as string)).status).toBe("success");
        }
        expect(host.runningImages()["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
      },
      900_000,
    );
  },
);
