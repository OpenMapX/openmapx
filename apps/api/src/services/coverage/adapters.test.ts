import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataManagerEvidenceReader } from "./adapters";

const headers = { "cache-control": "private, no-store", pragma: "no-cache" };
function page(snapshotId: string, hasMore = false) {
  return {
    schemaVersion: 1,
    snapshotId,
    generatedAt: "2026-10-19T00:00:00.000Z",
    evaluatedAt: "2026-10-19T00:00:00.000Z",
    collectionStatus: "complete",
    authorities: [],
    warnings: [],
    regions: [],
    evidence: [],
    rights: [],
    total: 0,
    retainedTotal: 0,
    truncated: false,
    unassignedSourceCount: 0,
    pagination: { offset: 0, limit: 100, total: 0, hasMore, snapshotId },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("generated data-manager evidence acquisition", () => {
  it("retries an expired immutable revision once and sends the service credential", async () => {
    const urls: string[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      urls.push(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(init?.redirect).toBe("error");
      if (urls.length === 1) return Response.json(page("expired", true), { headers });
      if (urls.length === 2)
        return Response.json({ error: "snapshot_expired" }, { status: 409, headers });
      return Response.json(page("current"), { headers });
    });
    const reader = createDataManagerEvidenceReader({
      baseUrl: "https://dm.example.test",
      authToken: "secret",
    });
    await expect(reader.read()).resolves.toMatchObject({ snapshotId: "current", rights: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(urls[1]).toContain("snapshotId=expired");
    expect(urls[2]).not.toContain("snapshotId=");
  });
  it("does not manufacture an available snapshot from malformed success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { headers }));
    const reader = createDataManagerEvidenceReader({ baseUrl: "https://dm.example.test" });
    await expect(reader.read()).rejects.toMatchObject({
      name: "DataManagerEvidenceUnavailableError",
    });
  });
  it("bounds expired-revision retries and retains the checked HTTP status", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ error: "snapshot_expired" }, { status: 409, headers }),
      );
    const reader = createDataManagerEvidenceReader({ baseUrl: "https://dm.example.test" });
    await expect(reader.read()).rejects.toMatchObject({
      name: "DataManagerEvidenceUnavailableError",
      status: 409,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
