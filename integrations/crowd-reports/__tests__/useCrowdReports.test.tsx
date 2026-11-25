import { CALLER_SHOWS_ERRORS, isErrorShownByCaller } from "@openmapx/core";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { nth, renderHookWithQuery, waitFor } from "@/test";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

// jsdom has no IndexedDB; the identity is kept in memory with the same record shape.
const keyStore = vi.hoisted(() => ({ value: undefined as unknown, databases: [] as unknown[] }));
vi.mock("@openmapx/openconditions-contrib-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/openconditions-contrib-client")>()),
  indexedDbDeviceKeyStore: (options: unknown) => {
    keyStore.databases.push(options);
    return {
      get: () => keyStore.value,
      set: (value: unknown) => {
        keyStore.value = value;
      },
    };
  },
}));

import { loadOrCreateDeviceKey } from "@openmapx/openconditions-contrib-client";
import { buildReportClaim } from "../claim";
import { type SubmitReportResult, useSubmitReport, useVote } from "../useCrowdReports";

const GRANT_STORAGE_KEY = "openmapx:crowd:grant";
const ENROLL_URL = "https://api.test/api/integrations/crowd-reports/enroll";
const REPORTS_URL = "https://api.test/api/integrations/crowd-reports/reports";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** Route the mock by URL: enroll → entitlement, vote → ok, submit → the landed record. */
function routeFetch(grant: unknown = "GRANT-FROM-ENROLL") {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/enroll")) {
      return Promise.resolve({ ok: true, json: async () => ({ reportingGrant: grant }) });
    }
    if (url.includes("/reports/")) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        record: { class: "situation", id: "r1" },
        evidenceState: "self_reported",
        routingEligible: false,
      }),
    });
  });
}

/** The device's key id, minting the identity in the in-memory store when needed. */
async function deviceKeyId(): Promise<string> {
  const key = await loadOrCreateDeviceKey({
    get: () => keyStore.value,
    set: (value) => {
      keyStore.value = value;
    },
  });
  return key.keyId;
}

async function seedGrant(reportingGrant: unknown, issuedAt: number, keyId?: string) {
  window.localStorage.setItem(
    GRANT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      keyId: keyId ?? (await deviceKeyId()),
      reportingGrant,
      issuedAt,
    }),
  );
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
  keyStore.value = undefined;
  keyStore.databases = [];
});

describe("useSubmitReport", () => {
  it("enrolls first on a fresh device, then POSTs { report, reportingGrant }", async () => {
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [enrollUrl, enrollInit] = nth(fetchMock.mock.calls, 0);
    expect(enrollUrl).toBe(ENROLL_URL);
    const enrollBody = JSON.parse(enrollInit.body as string);
    expect(typeof enrollBody.pubJwk).toBe("object");
    expect(typeof enrollBody.proof.keyId).toBe("string");

    const [submitUrl, submitInit] = nth(fetchMock.mock.calls, 1);
    expect(submitUrl).toBe(REPORTS_URL);
    const sent = JSON.parse(submitInit.body as string);
    expect(sent.reportingGrant).toBe("GRANT-FROM-ENROLL");
    expect(sent.report.alg).toBe("ES256");
    expect(typeof sent.report.keyId).toBe("string");
    expect(typeof sent.report.signature).toBe("string");
    expect(sent.report.claim).toEqual(CLAIM);
    expect(result.current.data?.record).toEqual({ class: "situation", id: "r1" });
  });

  it("uses a fresh cached grant without re-enrolling", async () => {
    await seedGrant("CACHED-GRANT", Date.now());
    routeFetch();
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [submitUrl, submitInit] = nth(fetchMock.mock.calls, 0);
    expect(submitUrl).toBe(REPORTS_URL);
    expect(JSON.parse(submitInit.body as string).reportingGrant).toBe("CACHED-GRANT");
  });

  it("carries a caller's error display choice to the mutation", async () => {
    await seedGrant("CACHED-GRANT", Date.now());
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const { result, queryClient } = renderHookWithQuery(() => useSubmitReport(CALLER_SHOWS_ERRORS));

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isError).toBe(true));

    const mutation = nth(queryClient.getMutationCache().getAll(), 0);
    expect(isErrorShownByCaller(mutation.options.meta)).toBe(true);
  });

  it("passes on a landed record that has no evidence state", async () => {
    await seedGrant("CACHED-GRANT", Date.now());
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        record: { class: "situation", id: "r2" },
        evidenceState: null,
        routingEligible: false,
      }),
    });
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.evidenceState).toBeNull();
    expectTypeOf<SubmitReportResult["evidenceState"]>().toEqualTypeOf<string | null>();
  });

  it("keeps the identity as a non-extractable key pair in the crowd database", async () => {
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(keyStore.databases).toContainEqual({
      databaseName: "openmapx:crowd",
      recordKey: "openmapx:crowd:device-key",
      onClosed: expect.any(Function),
    });
    const record = keyStore.value as { version: number; keyId: string; keyPair: CryptoKeyPair };
    expect(record.version).toBe(1);
    expect(record.keyPair.privateKey.extractable).toBe(false);
    const grant = JSON.parse(window.localStorage.getItem(GRANT_STORAGE_KEY) ?? "null");
    expect(grant).toMatchObject({
      version: 1,
      keyId: record.keyId,
      reportingGrant: "GRANT-FROM-ENROLL",
    });
    const sent = JSON.parse(nth(fetchMock.mock.calls, 1)[1].body as string);
    expect(sent.report.keyId).toBe(record.keyId);
  });

  it("stops signing with the held key once the stored identity is deleted", async () => {
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const firstKeyId = (keyStore.value as { keyId: string }).keyId;

    // Another context deletes the database: the store reports it closed.
    keyStore.value = undefined;
    (keyStore.databases.at(-1) as { onClosed: () => void }).onClosed();
    result.current.mutate(CLAIM);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const reports = fetchMock.mock.calls
      .filter(([url]) => url === REPORTS_URL)
      .map(([, init]) => JSON.parse(init.body as string).report.keyId);
    expect(reports).toHaveLength(2);
    expect(reports[1]).not.toBe(firstKeyId);
    expect(reports[1]).toBe((keyStore.value as { keyId: string }).keyId);
  });

  it("re-enrolls instead of using a grant issued for another key", async () => {
    await seedGrant("OTHER-KEY-GRANT", Date.now(), "another-key-id");
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(nth(fetchMock.mock.calls, 0)[0]).toBe(ENROLL_URL);
    expect(JSON.parse(nth(fetchMock.mock.calls, 1)[1].body as string).reportingGrant).toBe(
      "GRANT-FROM-ENROLL",
    );
  });

  it("re-enrolls when the cached grant is expired", async () => {
    await seedGrant("STALE-GRANT", Date.now() - 24 * 60 * 60 * 1000);
    routeFetch("GRANT-FROM-ENROLL");
    const { result } = renderHookWithQuery(() => useSubmitReport());

    result.current.mutate(CLAIM);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(nth(fetchMock.mock.calls, 0)[0]).toBe(ENROLL_URL);
    expect(JSON.parse(nth(fetchMock.mock.calls, 1)[1].body as string).reportingGrant).toBe(
      "GRANT-FROM-ENROLL",
    );
  });
});

describe("useVote", () => {
  it("signs a sub-claim naming the record and POSTs it to /reports/:class/:id/:action", async () => {
    await seedGrant("CACHED-GRANT", Date.now());
    routeFetch();
    const { result } = renderHookWithQuery(() => useVote());

    result.current.mutate({ subject: { class: "situation", id: "sit:42" }, action: "confirm" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = nth(fetchMock.mock.calls, 0);
    expect(url).toBe(
      "https://api.test/api/integrations/crowd-reports/reports/situation/sit%3A42/confirm",
    );
    const sent = JSON.parse(init.body as string);
    expect(sent.reportingGrant).toBe("CACHED-GRANT");
    expect(sent.subClaim.v).toBe(1);
    expect(sent.subClaim.claimType).toBe("confirm");
    expect(sent.subClaim.subject).toEqual({ class: "situation", id: "sit:42" });
    expect(typeof sent.subClaim.signature).toBe("string");
  });

  it("passes a feature component through as a query", async () => {
    await seedGrant("CACHED-GRANT", Date.now());
    routeFetch();
    const { result } = renderHookWithQuery(() => useVote());

    result.current.mutate({
      subject: { class: "feature", id: "feature:1", componentKey: "lane 1" },
      action: "negate",
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = nth(fetchMock.mock.calls, 0);
    expect(url).toBe(
      "https://api.test/api/integrations/crowd-reports/reports/feature/feature%3A1/negate?component=lane%201",
    );
    expect(JSON.parse(init.body as string).subClaim.subject).toEqual({
      class: "feature",
      id: "feature:1",
      componentKey: "lane 1",
    });
  });
});
