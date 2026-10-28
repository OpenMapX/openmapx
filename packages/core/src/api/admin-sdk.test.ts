import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "./admin-sdk";
import { ApiClientError, createApiClient } from "./client";
import { dataManagerAdminOperations } from "./contracts/data-manager-admin";

const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
afterEach(() => vi.unstubAllGlobals());
describe("complete generated administration operations", () => {
  it("exposes all28canonical operation keys", () => {
    expect(Object.keys(dataManagerAdminOperations)).toHaveLength(28);
    for (const key of Object.keys(dataManagerAdminOperations))
      expect(sdk).toHaveProperty(key, expect.any(Function));
  });
  it("retains202acceptance and409/422domain failures as distinct validated unions", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: true, jobId: "job", status: "started" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: false, reason: "in-flight", existingJobId: "job" }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: false, reason: "out-of-scope" }, { status: 422 }));
    vi.stubGlobal("fetch", fetch);
    const accepted = await sdk.postApiDataManagerTransitSync(
      {
        countries: ["de"],
        preflightId: "00000000-0000-4000-8000-000000000001",
        fingerprint: "a".repeat(64),
      },
      { client },
    );
    expect(sdk.unwrapAdminResponse(accepted).jobId).toBe("job");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      countries: ["de"],
      preflightId: "00000000-0000-4000-8000-000000000001",
      fingerprint: "a".repeat(64),
    });
    const conflict = await sdk.postApiDataManagerTransitSync(
      {
        countries: ["de"],
        preflightId: "00000000-0000-4000-8000-000000000001",
        fingerprint: "a".repeat(64),
      },
      { client },
    );
    expect(conflict.status).toBe(409);
    expect(() => sdk.unwrapAdminResponse(conflict)).toThrow(ApiClientError);
    const rejected = await sdk.postApiDataManagerTransitSync(
      {
        countries: ["de"],
        preflightId: "00000000-0000-4000-8000-000000000001",
        fingerprint: "a".repeat(64),
      },
      { client },
    );
    expect(rejected.status).toBe(422);
  });
  it.each([400, 401, 403, 404, 429, 500])(
    "retains declared status%s without accepting malformed errors",
    async (status) => {
      const payload = status === 429 ? { error: "limited", retryAfter: 30 } : { error: "failed" };
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(payload, {
            status,
            headers: status === 429 ? { "retry-after": "30" } : {},
          }),
        )
        .mockResolvedValueOnce(
          Response.json(
            { secret: "malformed" },
            { status, headers: status === 429 ? { "retry-after": "30" } : {} },
          ),
        );
      vi.stubGlobal("fetch", fetch);
      const response = await sdk.getApiDataManagerSearchIndexStatus({ client });
      expect(response.status).toBe(status);
      await expect(sdk.getApiDataManagerSearchIndexStatus({ client })).rejects.toMatchObject({
        name: "ApiContractError",
        status,
      });
    },
  );
  it("encodes named IDs, generated filters and preserves cookie scope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "absent" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ feeds: [], total: 0, limit: 100, offset: 0 }));
    vi.stubGlobal("fetch", fetch);
    const absent = await sdk.getApiDataManagerTransitJobsId("job /街?", { client });
    expect(absent.status).toBe(404);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://app.example/api/data-manager/transit/jobs/job%20%2F%E8%A1%97%3F",
    );
    await sdk.getApiDataManagerTransitFeeds(
      { region: "de & at", limit: 100, offset: 0 },
      { client },
    );
    const request = new URL(fetch.mock.calls[1]?.[0]);
    expect(request.searchParams.get("region")).toBe("de & at");
    expect(request.searchParams.get("offset")).toBe("0");
    expect(fetch.mock.calls[1]?.[1].credentials).toBe("include");
  });
  it("preserves structured job and stage JSON without assertion-only parsing", async () => {
    const job = {
      id: "job",
      kind: "sync",
      status: "failed",
      startedAt: "2026-10-19T00:00:00Z",
      finishedAt: null,
      triggeredBy: null,
      idempotencyKey: null,
      metadata: { nested: [1, null, true] },
      stages: [
        {
          id: "stage",
          stage: "build",
          status: "failed",
          startedAt: "2026-10-19T00:00:00Z",
          finishedAt: "2026-10-19T00:01:00Z",
          durationMs: 60000,
          message: null,
          error: { code: "disk", context: ["volume"] },
          artifacts: null,
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(job)));
    expect(
      sdk.unwrapAdminResponse(await sdk.getApiDataManagerTransitJobsId("job", { client })),
    ).toEqual(job);
  });
});
