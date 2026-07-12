import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHookWithQuery, waitFor } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

import { buildReportClaim } from "../claim";
import { useSubmitReport, useVote } from "../useCrowdReports";

const GRANT_STORAGE_KEY = "openconditions.contrib.grant";
const ENROLL_URL = "https://api.test/api/integrations/crowd-reports/enroll";
const REPORTS_URL = "https://api.test/api/integrations/crowd-reports/reports";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** Route the mock by URL: enroll → entitlement, vote → ok, submit → id. */
function routeFetch(grant: unknown = "GRANT-FROM-ENROLL") {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/enroll")) {
      return Promise.resolve({ ok: true, json: async () => ({ reportingGrant: grant }) });
    }
    if (url.includes("/reports/")) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ id: "r1" }) });
  });
}

function seedGrant(reportingGrant: unknown, issuedAt: number) {
  window.localStorage.setItem(GRANT_STORAGE_KEY, JSON.stringify({ reportingGrant, issuedAt }));
}

const CLAIM = buildReportClaim({
  category: "accident",
  fuzziness: "here",
  lon: 6.1,
  lat: 51.2,
  reportedAt: "2026-07-11T10:00:00.000Z",
  nonce: "fixednonce_1234567890",
});

afterEach(() => {
  fetchMock.mockReset();
  window.localStorage.clear();
});

describe("useSubmitReport", () => {
  it("enrolls first on a fresh device, then POSTs { report, reportingGrant }", async () => {
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [enrollUrl, enrollInit] = fetchMock.mock.calls[0];
    expect(enrollUrl).toBe(ENROLL_URL);
    const enrollBody = JSON.parse(enrollInit.body as string);
    expect(typeof enrollBody.pubJwk).toBe("object");
    expect(typeof enrollBody.proof.keyId).toBe("string");

    const [submitUrl, submitInit] = fetchMock.mock.calls[1];
    expect(submitUrl).toBe(REPORTS_URL);
    const sent = JSON.parse(submitInit.body as string);
    expect(sent.reportingGrant).toBe("GRANT-FROM-ENROLL");
    expect(sent.report.alg).toBe("ES256");
    expect(typeof sent.report.keyId).toBe("string");
    expect(typeof sent.report.signature).toBe("string");
    expect(sent.report.claim).toEqual(CLAIM);
  });

  it("uses a fresh cached grant without re-enrolling", async () => {
    seedGrant("CACHED-GRANT", Date.now());
    routeFetch();
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [submitUrl, submitInit] = fetchMock.mock.calls[0];
    expect(submitUrl).toBe(REPORTS_URL);
    expect(JSON.parse(submitInit.body as string).reportingGrant).toBe("CACHED-GRANT");
  });

  it("re-enrolls when the cached grant is expired", async () => {
    seedGrant("STALE-GRANT", Date.now() - 24 * 60 * 60 * 1000);
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(ENROLL_URL);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).reportingGrant).toBe(
      "GRANT-FROM-ENROLL",
    );
  });
});

describe("useVote", () => {
  it("signs a sub-claim and POSTs { subClaim, reportingGrant } to /reports/:id/:action", async () => {
    seedGrant("CACHED-GRANT", Date.now());
    routeFetch();
    const { result } = renderHookWithQuery(() => useVote());

    result.current.mutate({ reportId: "crowd:42", subject: "crowd:42", action: "confirm" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/integrations/crowd-reports/reports/crowd%3A42/confirm");
    const sent = JSON.parse(init.body as string);
    expect(sent.reportingGrant).toBe("CACHED-GRANT");
    expect(sent.subClaim.claimType).toBe("confirm");
    expect(sent.subClaim.subject).toBe("crowd:42");
    expect(typeof sent.subClaim.signature).toBe("string");
  });
});
