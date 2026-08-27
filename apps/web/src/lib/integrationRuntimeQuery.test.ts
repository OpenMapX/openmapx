import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  integrationRuntimeQueryKey,
  invalidateIntegrationRuntime,
} from "./integrationRuntimeQuery";

describe("integration runtime query", () => {
  it("invalidates the provider cache using a normalized API base", async () => {
    const client = new QueryClient();
    const key = integrationRuntimeQueryKey("https://api.example.test");
    client.setQueryData(key, { revision: "old" });

    await invalidateIntegrationRuntime(client, "https://api.example.test/");

    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
