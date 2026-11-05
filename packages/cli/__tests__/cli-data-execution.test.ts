import { expect, it } from "vitest";
import { executeDurableDataStep } from "../src/lib/data-execution";

it("refuses an unowned durable data step before any POST", async () => {
  let effects = 0;
  await expect(
    executeDurableDataStep(
      { kind: "download-fonts" },
      {
        operationKey: "opk1_abcdefghijklmnop",
        requestedDeadlineAt: Date.now() + 60000,
        observerDeadlineAt: Date.now() + 60000,
        transport: {
          request: async () => {
            effects++;
            throw Error("Must not acquire");
          },
        },
        checkpointAttempt: async () => {},
        checkpoint: async () => {},
      },
    ),
  ).rejects.toThrow("Retained data command owner required");
  expect(effects).toBe(0);
});
