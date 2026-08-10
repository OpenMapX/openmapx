import { describe, expect, it, vi } from "vitest";
import { loadOsmConfig } from "../../../utils/osm-config.js";
import { createOsmAccountService, deriveCapabilities } from "../account.js";
import type { OsmApiClient } from "../types.js";

const TOKEN = "osm-token-sentinel-never-exposed";
const COMMENT = "human-comment-sentinel";

const config = loadOsmConfig({
  OSM_CLIENT_ID: "id",
  OSM_CLIENT_SECRET: "secret",
  OSM_CONTRIBUTIONS_ENABLED: "true",
  OSM_DIRECT_EDITING_ENABLED: "true",
});

function upstream(overrides: Partial<OsmApiClient> = {}): OsmApiClient {
  return {
    getPermissions: vi.fn(async () => ({ allowWriteApi: true, allowWriteNotes: true })),
    getUserDetails: vi.fn(async () => ({
      id: 7,
      displayName: "mapper",
      contributorTermsAgreed: true,
      activeBlock: false,
    })),
    getElement: vi.fn(),
    getFullElement: vi.fn(),
    createChangeset: vi.fn(),
    updateElement: vi.fn(),
    closeChangeset: vi.fn(),
    getChangeset: vi.fn(),
    createNote: vi.fn(),
    ...overrides,
  } as unknown as OsmApiClient;
}

function service(
  resolution: Awaited<ReturnType<Parameters<typeof createOsmAccountService>[0]["resolveToken"]>>,
  client = upstream(),
) {
  const resolveToken = vi.fn(async () => resolution);
  return {
    account: createOsmAccountService({ config, client, resolveToken }),
    resolveToken,
    client,
  };
}

const headers = new Headers();

describe("account state", () => {
  it("reports not linked without contacting OSM", async () => {
    const { account, client } = service({ status: "not_linked" });
    const state = await account.load(headers);
    expect(state.status).toBe("not_linked");
    expect(client.getPermissions).not.toHaveBeenCalled();
  });

  it("maps a Better Auth failure to reauthorization required", async () => {
    const { account, client } = service({ status: "reauthorization_required" });
    expect((await account.load(headers)).status).toBe("reauthorization_required");
    expect(client.getPermissions).not.toHaveBeenCalled();
  });

  it("verifies rights through the live permissions endpoint, not the stored scope", async () => {
    const client = upstream({
      getPermissions: vi.fn(async () => ({ allowWriteApi: false, allowWriteNotes: true })),
    });
    const { account } = service(
      { status: "ok", accessToken: TOKEN, scopes: ["openid", "read_prefs", "write_api"] },
      client,
    );
    const state = await account.load(headers);
    expect(state.status).toBe("linked");
    if (state.status !== "linked") return;
    // The stored scope string claims write_api; OSM says otherwise and wins.
    expect(state.permissions).toEqual({ allowWriteApi: false, allowWriteNotes: true });
  });

  it("exposes contributor-terms and block state from user details", async () => {
    const client = upstream({
      getUserDetails: vi.fn(async () => ({
        id: 7,
        displayName: "mapper",
        contributorTermsAgreed: false,
        activeBlock: true,
      })),
    });
    const { account } = service({ status: "ok", accessToken: TOKEN, scopes: [] }, client);
    const state = await account.load(headers);
    if (state.status !== "linked") throw new Error("expected linked");
    expect(state.user.contributorTermsAgreed).toBe(false);
    expect(state.user.activeBlock).toBe(true);
  });

  it("maps an upstream 401 during verification to reauthorization required", async () => {
    const client = upstream({
      getPermissions: vi.fn(async () => {
        throw Object.assign(new Error("upstream responded 401"), {
          name: "OsmUpstreamError",
          status: 401,
        });
      }),
    });
    const { account } = service({ status: "ok", accessToken: TOKEN, scopes: [] }, client);
    expect((await account.load(headers)).status).toBe("reauthorization_required");
  });
});

describe("public capability projection", () => {
  it("never exposes the token or a raw upstream message", () => {
    const capabilities = deriveCapabilities({
      config,
      state: {
        status: "linked",
        accessToken: TOKEN,
        scopes: ["openid", "read_prefs", "write_notes"],
        permissions: { allowWriteApi: false, allowWriteNotes: true },
        user: { id: 7, displayName: "mapper", contributorTermsAgreed: true, activeBlock: false },
      },
    });
    const serialized = JSON.stringify(capabilities);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(COMMENT);
    expect(capabilities.account).toEqual({
      id: 7,
      displayName: "mapper",
      profileUrl: "https://www.openstreetmap.org/user/mapper",
    });
  });

  it("distinguishes every gate state", () => {
    const base = { config } as const;
    expect(deriveCapabilities({ ...base, state: { status: "not_linked" } })).toMatchObject({
      linked: false,
      canWriteApi: false,
      canWriteNotes: false,
      actions: { reauthorize: true },
    });
    expect(
      deriveCapabilities({ ...base, state: { status: "reauthorization_required" } }),
    ).toMatchObject({ linked: true, canWriteApi: false, actions: { reauthorize: true } });

    const blocked = deriveCapabilities({
      ...base,
      state: {
        status: "linked",
        accessToken: TOKEN,
        scopes: [],
        permissions: { allowWriteApi: true, allowWriteNotes: true },
        user: { id: 7, displayName: "mapper", contributorTermsAgreed: false, activeBlock: true },
      },
    });
    expect(blocked.activeBlock).toBe(true);
    expect(blocked.contributorTermsAgreed).toBe(false);
    expect(blocked.actions.contributorTermsUrl).toBe("https://www.openstreetmap.org/user/terms");
    expect(blocked.actions.accountMessagesUrl).toBe("https://www.openstreetmap.org/messages/inbox");
  });

  it("lists only missing known scopes", () => {
    const capabilities = deriveCapabilities({
      config,
      state: {
        status: "linked",
        accessToken: TOKEN,
        scopes: [],
        permissions: { allowWriteApi: false, allowWriteNotes: true },
        user: { id: 7, displayName: "mapper", contributorTermsAgreed: true, activeBlock: false },
      },
    });
    expect(capabilities.requiredScopes).toEqual(["write_api"]);
  });

  it("fails closed when OAuth is not configured even if the flag is on", () => {
    const unconfigured = loadOsmConfig({ OSM_CONTRIBUTIONS_ENABLED: "true" });
    const capabilities = deriveCapabilities({
      config: unconfigured,
      state: { status: "not_linked" },
    });
    expect(capabilities.enabled).toBe(false);
    expect(capabilities.directEditingEnabled).toBe(false);
  });

  it("reflects the direct-editing kill switch independently", () => {
    const noDirect = loadOsmConfig({
      OSM_CLIENT_ID: "id",
      OSM_CLIENT_SECRET: "secret",
      OSM_CONTRIBUTIONS_ENABLED: "true",
    });
    const capabilities = deriveCapabilities({ config: noDirect, state: { status: "not_linked" } });
    expect(capabilities.enabled).toBe(true);
    expect(capabilities.directEditingEnabled).toBe(false);
  });
});
