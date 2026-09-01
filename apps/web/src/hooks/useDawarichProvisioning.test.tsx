import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHookWithQuery } from "@/test";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

import { useDawarichProvisioning } from "./useDawarichProvisioning";

const status = {
  installed: true,
  selected: false,
  running: false,
  healthy: false,
  publicOrigin: "https://timeline.example.test",
  oauthClient: {
    present: true,
    clientId: null,
    redirectUriMatches: true,
    settingsMatch: true,
    recoveryRequired: false,
  },
  secrets: {
    databasePassword: "consistent",
    secretKeyBase: "consistent",
    oidcClientSecret: "consistent",
  },
  configReady: true,
  readyToStart: true,
  needsApply: true,
} as const;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("useDawarichProvisioning", () => {
  it("loads only the redacted admin status without browser caching", async () => {
    fetchMock.mockResolvedValue(jsonResponse(status));
    const { result } = renderHookWithQuery(() => useDawarichProvisioning());

    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/admin/dawarich", {
      credentials: "include",
      cache: "no-store",
    });
    const serialized = JSON.stringify(result.current.statusQuery.data);
    expect(serialized).not.toContain('"clientSecret":');
    expect(serialized).not.toContain('"apiKey":');
  });

  it("normalizes provisioning into the exact server request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(status));
    const { result } = renderHookWithQuery(() => useDawarichProvisioning());
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    fetchMock.mockClear();

    await act(() => result.current.provision.mutateAsync("timeline.example.test"));

    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/admin/dawarich/provision", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicHost: "timeline.example.test" }),
    });
  });

  it("uses an exact typed confirmation for explicit OIDC rotation", async () => {
    fetchMock.mockResolvedValue(jsonResponse(status));
    const { result } = renderHookWithQuery(() => useDawarichProvisioning());
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    fetchMock.mockClear();

    await act(() => result.current.rotate.mutateAsync());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/admin/dawarich/rotate-oidc-secret",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirmation: "ROTATE DAWARICH OIDC SECRET" }),
      }),
    );
  });

  it("surfaces a stable server code instead of a raw error body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { code: "DAWARICH_DATABASE_SECRET_CONFLICT", detail: "password=do-not-show" },
        false,
      ),
    );
    const { result } = renderHookWithQuery(() => useDawarichProvisioning());

    await waitFor(() => expect(result.current.statusQuery.isError).toBe(true));
    expect(result.current.statusQuery.error?.message).toBe("DAWARICH_DATABASE_SECRET_CONFLICT");
    expect(result.current.statusQuery.error?.message).not.toContain("do-not-show");
  });
});
