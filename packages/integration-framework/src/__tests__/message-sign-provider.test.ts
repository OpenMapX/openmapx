import type { MessageSign } from "@openmapx/mobility-core/message-sign";
import { describe, expect, test } from "vitest";
import type { MessageSignProvider } from "../contracts/message-sign-provider.js";
import { createMockIntegrationContext } from "../testing/index.js";

const sign: MessageSign = {
  id: "oc:feature:us-test-signs:1",
  name: "I-87 NB at Exit 6",
  type: "matrix",
  coordinates: [-73.79, 42.78],
  status: "in_service",
  pages: [["CRASH AHEAD", "EXIT 7"]],
  sources: ["us-test-signs"],
  attributions: [],
};

describe("registerMessageSignProvider", () => {
  test("stores the provider under messageSigns", async () => {
    const ctx = createMockIntegrationContext();
    const provider: MessageSignProvider = {
      id: "test",
      coverage: { all: true },
      searchSigns: async () => ({ signs: [sign] }),
      getSign: async () => sign,
    };
    ctx.registerMessageSignProvider(provider);
    expect(ctx.registered.messageSigns).toEqual([provider]);
    await expect(ctx.registered.messageSigns[0]?.getSign(sign.id)).resolves.toBe(sign);
  });
});
