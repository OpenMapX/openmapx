import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { setup } from "../index.js";

const URL_ONLY = { OPENCONDITIONS_URL: "http://oc.test:4100/" };

describe("createOpenConditionsClient", () => {
  test("no OPENCONDITIONS_URL, no client and no provider", async () => {
    expect(createOpenConditionsClient({}, fakeHttpClient())).toBeNull();
    expect(createOpenConditionsClient({ OPENCONDITIONS_URL: "   " }, fakeHttpClient())).toBeNull();

    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, {});
    expect(ctx.registered.roadConditions).toEqual([]);
    expect(ctx.registered.dataSourceLists).toEqual([]);
  });

  test("setup registers the road-conditions provider when OPENCONDITIONS_URL is set", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, URL_ONLY);
    expect(ctx.registered.roadConditions.map((p) => p.id)).toEqual([
      "road-conditions-openconditions",
    ]);
  });

  test("the client sends the operator token as a bearer header", async () => {
    const http = fakeHttpClient({ "/situations": { records: [], next: null } });
    const client = createOpenConditionsClient(
      { ...URL_ONLY, OPENCONDITIONS_OPERATOR_TOKEN: " s3cret " },
      http,
    )!;
    expect(client.baseUrl).toBe("http://oc.test:4100");
    await client.get("/situations", { bbox: "1,2,3,4", limit: 10, kind: undefined });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe("http://oc.test:4100/situations");
    expect(http.calls[0]!.options).toMatchObject({
      params: { bbox: "1,2,3,4", limit: 10 },
      headers: { Authorization: "Bearer s3cret" },
    });
  });

  test("the client sends no Authorization header without a token", async () => {
    const http = fakeHttpClient({ "/feeds/status": {} });
    const client = createOpenConditionsClient(
      { ...URL_ONLY, OPENCONDITIONS_OPERATOR_TOKEN: "" },
      http,
    )!;
    await client.get("/feeds/status");
    const headers = (http.calls[0]!.options?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  test("the client passes its timeout and response cap and never asks for a shared cache", async () => {
    const http = fakeHttpClient({ "/segments/conditions.json": {} });
    const client = createOpenConditionsClient(URL_ONLY, http)!;
    await client.get("/segments/conditions.json", undefined, {
      timeoutMs: 2000,
      maxResponseBytes: 1024,
    });
    expect(http.calls[0]!.options).toMatchObject({ timeoutMs: 2000, maxResponseBytes: 1024 });
    expect(http.calls[0]!.options?.cache).toBeUndefined();
  });

  test("an optional read is null on 404 and fails on any other error status", async () => {
    const http = fakeHttpClient((req) =>
      req.url.endsWith("/features/missing")
        ? { status: 404, headers: {}, body: { error: "no such feature" } }
        : req.url.endsWith("/features/broken")
          ? { status: 500, headers: {}, body: { error: "boom" } }
          : { status: 200, headers: {}, body: { record: { id: "x" } } },
    );
    const client = createOpenConditionsClient(
      { ...URL_ONLY, OPENCONDITIONS_OPERATOR_TOKEN: "s3cret" },
      http,
    )!;

    expect(await client.getOptional("/features/missing")).toBeNull();
    await expect(client.getOptional("/features/broken")).rejects.toThrow(/500/);
    expect(await client.getOptional("/features/x", { expand: "latest" })).toEqual({
      record: { id: "x" },
    });
    expect(http.calls[2]!.options).toMatchObject({
      params: { expand: "latest" },
      headers: { Authorization: "Bearer s3cret" },
      contentTypes: ["application/json"],
    });
    expect(http.calls[2]!.options?.cache).toBeUndefined();
  });
});
