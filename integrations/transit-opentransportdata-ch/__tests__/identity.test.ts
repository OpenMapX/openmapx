import type { BinaryLike } from "node:crypto";
import { createPassthroughCache, fakeHttpClient } from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSwissTransitClient } from "../client.js";
import { allowQuota } from "./helpers.js";

const { unkeyedInputs } = vi.hoisted(() => ({ unkeyedInputs: [] as string[] }));
vi.mock("node:crypto", async (load) => {
  const crypto = await load<typeof import("node:crypto")>();
  return {
    ...crypto,
    createHash: (...args: Parameters<typeof crypto.createHash>) => {
      const hash = crypto.createHash(...args);
      const update = hash.update.bind(hash);
      vi.spyOn(hash, "update").mockImplementation((data: BinaryLike, encoding?: BufferEncoding) => {
        unkeyedInputs.push(
          typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"),
        );
        return typeof data === "string" && encoding ? update(data, encoding) : update(data);
      });
      return hash;
    },
  };
});

beforeEach(() => {
  unkeyedInputs.length = 0;
});
const token = "opaque-provider-issued-token-A-274e8c864c1b4371";
function instance(apiKey = token, extra: Record<string, string> = {}, name = "Original") {
  const runtime = allowQuota();
  const quota = vi.spyOn(runtime, "consumeQuota");
  const client = createSwissTransitClient({
    config: { apiKey, ...extra },
    cache: createPassthroughCache(),
    http: fakeHttpClient(() => "{}"),
    upstreamRuntime: runtime,
    contributors: {
      "opentransportdata-ch-formation": [{ sourceId: "opentransportdata-ch-formation", name }],
    },
  });
  return { client, quota };
}

describe("Swiss opaque credential identities", () => {
  it("keeps credential bytes out of every unkeyed hash input", () => {
    const { client } = instance();
    expect(unkeyedInputs.length).toBeGreaterThan(0);
    expect(unkeyedInputs.every((value) => !value.includes(token))).toBe(true);
    expect(client.cacheIdentity).not.toContain(token);
  });

  it("shares identical identities across instances and isolates changed credentials/configuration/receipts", () => {
    const first = instance();
    expect(instance().client.cacheIdentity).toBe(first.client.cacheIdentity);
    expect(instance(`${token}-different`).client.cacheIdentity).not.toBe(
      first.client.cacheIdentity,
    );
    expect(instance(token, { requestLanguage: "fr" }).client.cacheIdentity).not.toBe(
      first.client.cacheIdentity,
    );
    expect(instance(token, {}, "Changed").client.cacheIdentity).not.toBe(
      first.client.cacheIdentity,
    );
  });

  it("keeps quota identity stable across configuration/receipt generations but separates credentials", async () => {
    const first = instance();
    const second = instance(
      token,
      { formationEndpoint: "https://api.opentransportdata.swiss/other-formation" },
      "Changed",
    );
    const third = instance(`${token}-different`);
    for (const { client } of [first, second, third])
      await client.fetchSwissFormationJourney({
        evu: "SBBP",
        operationDate: "2025-02-03",
        trainNumber: "419",
      });
    const bucket = first.quota.mock.calls[0]?.[0].bucket;
    expect(second.quota.mock.calls[0]?.[0].bucket).toBe(bucket);
    expect(third.quota.mock.calls[0]?.[0].bucket).not.toBe(bucket);
    expect(bucket).not.toContain(token);
  });
});
