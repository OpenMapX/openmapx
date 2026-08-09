import type { ConnectPersonalTimelineRequest } from "@openmapx/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalTimelineConnectionRow } from "../../../db/timeline-connection-schema.js";
import { personalTimelineConnection } from "../../../db/timeline-connection-schema.js";
import { encrypt } from "../../secrets.js";
import { currentUserFixture, settingsFixture } from "../__fixtures__/timeline-day.js";
import { DawarichClientError, type DawarichClientOptions } from "../client.js";
import {
  type ManagedDawarichResolver,
  TimelineConnectionError,
  TimelineConnectionService,
  type TimelineConnectionStore,
} from "../connection-service.js";
import { timelinePrivateHostAllowlist } from "../private-hosts.js";

const SECRETS_KEY = Buffer.alloc(32, 7).toString("hex");
const USER_ID = "user-a";

function connectionRow(
  overrides: Partial<PersonalTimelineConnectionRow> = {},
): PersonalTimelineConnectionRow {
  return {
    id: "connection-a",
    userId: USER_ID,
    mode: "external",
    publicOrigin: "https://old.example",
    displayName: "Old timeline",
    encryptedApiKey: "old-ciphertext",
    encryptionIv: "old-iv",
    encryptionTag: "old-tag",
    upstreamUserId: null,
    upstreamEmail: "old@example.invalid",
    upstreamTimeZone: "Etc/UTC",
    distanceUnit: "km",
    status: "connected",
    consecutiveFailures: 0,
    validatedAt: new Date("2026-01-01T00:00:00Z"),
    lastReadAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

class MemoryConnectionStore implements TimelineConnectionStore {
  readonly rows = new Map<string, PersonalTimelineConnectionRow>();
  replaceCalls = 0;

  async findByUserId(userId: string) {
    return this.rows.get(userId) ?? null;
  }

  async replaceForUser(row: PersonalTimelineConnectionRow) {
    this.replaceCalls += 1;
    this.rows.set(row.userId, row);
    return row;
  }

  async updateForUser(
    userId: string,
    updates: Partial<PersonalTimelineConnectionRow>,
    expectedEncryptedApiKey?: string,
  ) {
    const current = this.rows.get(userId);
    if (!current) return null;
    if (expectedEncryptedApiKey && current.encryptedApiKey !== expectedEncryptedApiKey) return null;
    const next = { ...current, ...updates, userId: current.userId };
    this.rows.set(userId, next);
    return next;
  }

  async deleteForUser(userId: string) {
    this.rows.delete(userId);
  }
}

function healthyManagedResolver(): ManagedDawarichResolver {
  return {
    async resolve() {
      return {
        internalBaseUrl: "http://dawarich-app:3000",
        publicOrigin: "https://timeline.example.test",
        healthy: true,
        provisioned: true,
      };
    },
  };
}

function validClient() {
  return {
    getCurrentUser: vi.fn(async () => currentUserFixture),
    getSettings: vi.fn(async () => settingsFixture),
    getTimeline: vi.fn(async () => ({ days: [] })),
  };
}

beforeEach(() => {
  vi.stubEnv("OPENMAPX_SECRETS_KEY", SECRETS_KEY);
});

describe("personal timeline connection schema", () => {
  it("enforces one cascading, encrypted connection row per user", () => {
    const config = getTableConfig(personalTimelineConnection);

    expect(config.name).toBe("personal_timeline_connection");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "mode",
      "public_origin",
      "display_name",
      "encrypted_api_key",
      "encryption_iv",
      "encryption_tag",
      "upstream_user_id",
      "upstream_email",
      "upstream_time_zone",
      "distance_unit",
      "status",
      "consecutive_failures",
      "validated_at",
      "last_read_at",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "user_id"),
      ),
    ).toBe(true);
    const userId = config.columns.find((column) => column.name === "user_id");
    expect(userId?.notNull).toBe(true);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    for (const secretColumn of ["encrypted_api_key", "encryption_iv", "encryption_tag"]) {
      expect(config.columns.find((column) => column.name === secretColumn)?.notNull).toBe(true);
    }
    expect(config.columns.find((column) => column.name === "status")?.default).toBe("connected");
    expect(config.columns.find((column) => column.name === "consecutive_failures")?.default).toBe(
      0,
    );
  });
});

describe("timelinePrivateHostAllowlist", () => {
  it("reads only the timeline-specific variable and normalizes exact and wildcard hosts", () => {
    expect(
      timelinePrivateHostAllowlist({
        OPENMAPX_DAWARICH_PRIVATE_HOSTS:
          " Dawarich.LAN.,*.Example.Internal.,dawarich.lan, *.example.internal ",
        OPENMAPX_ALLOW_PRIVATE_FEED_HOSTS: "must-not-leak.internal",
      }),
    ).toEqual(["dawarich.lan", "*.example.internal"]);
  });

  it.each([
    "*",
    "https://dawarich.internal",
    "user@dawarich.internal",
    "dawarich.internal/path",
    "dawarich.internal:3000",
    ".internal",
    "internal..lan",
    "*.internal.*",
  ])("rejects an invalid or escalating host pattern: %s", (value) => {
    expect(() => timelinePrivateHostAllowlist({ OPENMAPX_DAWARICH_PRIVATE_HOSTS: value })).toThrow(
      /OPENMAPX_DAWARICH_PRIVATE_HOSTS/,
    );
  });

  it("returns an empty allowlist when the operator variable is absent or blank", () => {
    expect(timelinePrivateHostAllowlist({})).toEqual([]);
    expect(timelinePrivateHostAllowlist({ OPENMAPX_DAWARICH_PRIVATE_HOSTS: " , " })).toEqual([]);
  });
});

describe("TimelineConnectionService", () => {
  it("validates all read-only endpoints before atomically storing an encrypted external key", async () => {
    const store = new MemoryConnectionStore();
    const client = validClient();
    const options: DawarichClientOptions[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const service = new TimelineConnectionService({
      store,
      now: () => new Date("2026-02-02T12:00:00Z"),
      id: () => "new-connection",
      clientFactory: (candidate) => {
        options.push(candidate);
        return client;
      },
      privateHosts: ["*.example.internal"],
      audit: async (entry) => {
        audits.push(entry as unknown as Record<string, unknown>);
      },
    });

    const view = await service.connect(USER_ID, {
      mode: "external",
      instanceUrl: "https://DAWARICH.example.test/",
      apiKey: "top-secret-key",
      displayName: "My timeline",
    });

    expect(client.getCurrentUser).toHaveBeenCalledOnce();
    expect(client.getSettings).toHaveBeenCalledOnce();
    expect(client.getTimeline).toHaveBeenCalledOnce();
    expect(store.replaceCalls).toBe(1);
    expect(options).toEqual([
      expect.objectContaining({
        baseUrl: "https://dawarich.example.test",
        apiKey: "top-secret-key",
        allowPrivateHosts: ["*.example.internal"],
      }),
    ]);
    const stored = store.rows.get(USER_ID);
    expect(stored).toMatchObject({
      userId: USER_ID,
      mode: "external",
      publicOrigin: "https://dawarich.example.test",
      displayName: "My timeline",
      upstreamEmail: "fixture@example.invalid",
      upstreamTimeZone: "Etc/UTC",
      distanceUnit: "km",
      status: "connected",
      consecutiveFailures: 0,
    });
    expect(stored?.encryptedApiKey).not.toContain("top-secret-key");
    expect(stored?.encryptionIv).not.toBe("");
    expect(stored?.encryptionTag).not.toBe("");
    await expect(service.decryptConnectionCredential(USER_ID)).resolves.toMatchObject({
      apiKey: "top-secret-key",
      upstreamBaseUrl: "https://dawarich.example.test",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
    });
    expect(JSON.stringify(view)).not.toMatch(/top-secret|encrypted|cipher|encryption/i);
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: USER_ID,
        action: "timeline.connect",
        details: { mode: "external", hostname: "dawarich.example.test", outcome: "success" },
      }),
    ]);
  });

  it.each([
    "http://dawarich.example.test",
    "https://user:pass@dawarich.example.test",
    "https://dawarich.example.test/path",
    "https://dawarich.example.test/?query=yes",
    "https://dawarich.example.test/#fragment",
  ])("rejects an unsupported external origin before creating a client: %s", async (instanceUrl) => {
    const store = new MemoryConnectionStore();
    const clientFactory = vi.fn(() => validClient());
    const service = new TimelineConnectionService({ store, clientFactory });

    await expect(
      service.connect(USER_ID, { mode: "external", instanceUrl, apiKey: "key" }),
    ).rejects.toMatchObject({ code: "TIMELINE_INSTANCE_UNSUPPORTED" });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.replaceCalls).toBe(0);
  });

  it("preserves a prior row byte-for-byte when replacement validation fails", async () => {
    const store = new MemoryConnectionStore();
    store.rows.set(USER_ID, connectionRow());
    const before = structuredClone(store.rows.get(USER_ID));
    const client = validClient();
    client.getSettings.mockRejectedValueOnce(new DawarichClientError("invalid_response"));
    const service = new TimelineConnectionService({ store, clientFactory: () => client });

    await expect(
      service.connect(USER_ID, {
        mode: "external",
        instanceUrl: "https://new.example.test",
        apiKey: "bad-key",
      }),
    ).rejects.toMatchObject({ code: "TIMELINE_INSTANCE_UNSUPPORTED" });
    expect(store.rows.get(USER_ID)).toEqual(before);
    expect(store.replaceCalls).toBe(0);
  });

  it("uses only the managed resolver's internal and public URLs", async () => {
    const store = new MemoryConnectionStore();
    const options: DawarichClientOptions[] = [];
    const service = new TimelineConnectionService({
      store,
      managedResolver: healthyManagedResolver(),
      clientFactory: (candidate) => {
        options.push(candidate);
        return validClient();
      },
    });
    const payload = {
      mode: "managed",
      apiKey: "managed-key",
      instanceUrl: "http://attacker.internal",
    } as unknown as ConnectPersonalTimelineRequest;

    await expect(service.connect(USER_ID, payload)).rejects.toMatchObject({
      code: "TIMELINE_INSTANCE_UNSUPPORTED",
    });
    expect(options).toHaveLength(0);

    await service.connect(USER_ID, { mode: "managed", apiKey: "managed-key" });
    expect(options[0]).toMatchObject({
      baseUrl: "http://dawarich-app:3000",
      allowPrivateHosts: ["dawarich-app"],
    });
    expect(store.rows.get(USER_ID)).toMatchObject({
      mode: "managed",
      publicOrigin: "https://timeline.example.test",
    });
  });

  it("rejects unavailable managed service state without testing or deleting a stored row", async () => {
    const store = new MemoryConnectionStore();
    store.rows.set(USER_ID, connectionRow({ mode: "managed" }));
    const clientFactory = vi.fn(() => validClient());
    const service = new TimelineConnectionService({
      store,
      clientFactory,
      managedResolver: { resolve: async () => null },
    });

    await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
      code: "TIMELINE_MANAGED_DISABLED",
    });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.rows.has(USER_ID)).toBe(true);
  });

  it.each([
    {
      internalBaseUrl: "file:///etc/passwd",
      publicOrigin: "https://timeline.example.test",
    },
    {
      internalBaseUrl: "http://dawarich-app:3000",
      publicOrigin: "http://timeline.example.test",
    },
  ])("treats invalid operator-managed origins as managed unavailable", async (resolved) => {
    const store = new MemoryConnectionStore();
    const clientFactory = vi.fn(() => validClient());
    const service = new TimelineConnectionService({
      store,
      clientFactory,
      audit: async () => {},
      managedResolver: {
        resolve: async () => ({ ...resolved, healthy: true, provisioned: true }),
      },
    });

    await expect(
      service.connect(USER_ID, { mode: "managed", apiKey: "managed-key" }),
    ).rejects.toMatchObject({ code: "TIMELINE_MANAGED_DISABLED" });
    expect(clientFactory).not.toHaveBeenCalled();
    expect(store.replaceCalls).toBe(0);
  });

  it("marks auth failures invalid, degrades only after three transient failures, then recovers", async () => {
    const store = new MemoryConnectionStore();
    const encrypted = encrypt("stored-key");
    const encryptedKey = {
      encryptedApiKey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    };
    store.rows.set(USER_ID, connectionRow({ ...encryptedKey }));
    let failure: DawarichClientError | null = new DawarichClientError("unauthorized", 401);
    const service = new TimelineConnectionService({
      store,
      clientFactory: () => {
        const client = validClient();
        if (failure) client.getCurrentUser.mockRejectedValueOnce(failure);
        return client;
      },
    });

    await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
      code: "TIMELINE_CREDENTIAL_INVALID",
    });
    expect(store.rows.get(USER_ID)).toMatchObject({ status: "invalid", consecutiveFailures: 1 });

    store.rows.set(
      USER_ID,
      connectionRow({ ...encryptedKey, status: "connected", consecutiveFailures: 0 }),
    );
    failure = new DawarichClientError("unavailable", 503);
    for (const expectedFailures of [1, 2, 3]) {
      await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
        code: "TIMELINE_UPSTREAM_UNAVAILABLE",
      });
      expect(store.rows.get(USER_ID)).toMatchObject({
        status: expectedFailures < 3 ? "connected" : "degraded",
        consecutiveFailures: expectedFailures,
      });
    }

    failure = null;
    await service.testConnection(USER_ID);
    expect(store.rows.get(USER_ID)).toMatchObject({
      status: "connected",
      consecutiveFailures: 0,
      upstreamEmail: "fixture@example.invalid",
    });
  });

  it("does not apply a stale manual-test result after the user switches connections", async () => {
    const store = new MemoryConnectionStore();
    const oldEncrypted = encrypt("old-key");
    const newEncrypted = encrypt("new-key");
    store.rows.set(
      USER_ID,
      connectionRow({
        encryptedApiKey: oldEncrypted.ciphertext,
        encryptionIv: oldEncrypted.iv,
        encryptionTag: oldEncrypted.tag,
      }),
    );
    const switched = connectionRow({
      publicOrigin: "https://new.example",
      displayName: "New timeline",
      encryptedApiKey: newEncrypted.ciphertext,
      encryptionIv: newEncrypted.iv,
      encryptionTag: newEncrypted.tag,
      upstreamEmail: "new@example.invalid",
      status: "degraded",
      consecutiveFailures: 4,
    });
    const client = validClient();
    client.getTimeline.mockImplementationOnce(async () => {
      store.rows.set(USER_ID, switched);
      return { days: [] };
    });
    const service = new TimelineConnectionService({
      store,
      clientFactory: () => client,
      audit: async () => {},
    });

    await service.testConnection(USER_ID);

    expect(store.rows.get(USER_ID)).toEqual(switched);
  });

  it("scopes view, read-success and idempotent deletion to the supplied user", async () => {
    const store = new MemoryConnectionStore();
    const encrypted = encrypt("stored-key");
    const encryptedKey = {
      encryptedApiKey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    };
    store.rows.set(USER_ID, connectionRow({ ...encryptedKey }));
    store.rows.set(
      "user-b",
      connectionRow({ ...encryptedKey, id: "connection-b", userId: "user-b" }),
    );
    const service = new TimelineConnectionService({ store });

    const view = await service.getConnectionView(USER_ID);
    expect(view.connection).toMatchObject({ displayName: "Old timeline" });
    expect(JSON.stringify(view)).not.toMatch(/old-ciphertext|stored-key|encryption|encrypted/i);
    await service.recordReadSuccess(USER_ID);
    expect(store.rows.get(USER_ID)?.lastReadAt).toBeInstanceOf(Date);
    expect(store.rows.get("user-b")?.lastReadAt).toBeNull();
    await service.deleteConnection(USER_ID);
    await service.deleteConnection(USER_ID);
    expect(store.rows.has(USER_ID)).toBe(false);
    expect(store.rows.has("user-b")).toBe(true);
  });

  it("writes only safe audit dimensions on a rejected switch and manual test", async () => {
    const store = new MemoryConnectionStore();
    const encrypted = encrypt("stored-key");
    const encryptedKey = {
      encryptedApiKey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    };
    store.rows.set(USER_ID, connectionRow({ ...encryptedKey }));
    const audits: Array<Record<string, unknown>> = [];
    const service = new TimelineConnectionService({
      store,
      audit: async (entry) => {
        audits.push(entry as unknown as Record<string, unknown>);
      },
      clientFactory: () => {
        const client = validClient();
        client.getCurrentUser.mockRejectedValueOnce(new DawarichClientError("forbidden", 403));
        return client;
      },
    });

    await expect(service.testConnection(USER_ID)).rejects.toBeInstanceOf(TimelineConnectionError);
    await expect(
      service.connect(USER_ID, {
        mode: "external",
        instanceUrl: "https://new.example.test",
        apiKey: "new-secret-key",
        displayName: "Private Person",
      }),
    ).rejects.toBeInstanceOf(TimelineConnectionError);

    const serialized = JSON.stringify(audits);
    expect(serialized).not.toMatch(/stored-key|new-secret-key|private person|fixture@|coordinate/i);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "timeline.test",
        details: { mode: "external", hostname: "old.example", outcome: "failure" },
      }),
      expect.objectContaining({
        action: "timeline.switch",
        details: { mode: "external", hostname: "new.example.test", outcome: "failure" },
      }),
    ]);
  });

  it("retains the safe source mode in audit details when origin validation rejects", async () => {
    const store = new MemoryConnectionStore();
    const audits: Array<Record<string, unknown>> = [];
    const service = new TimelineConnectionService({
      store,
      audit: async (entry) => {
        audits.push(entry as unknown as Record<string, unknown>);
      },
    });

    await expect(
      service.connect(USER_ID, {
        mode: "external",
        instanceUrl: "http://private.invalid/path",
        apiKey: "secret-key",
      }),
    ).rejects.toMatchObject({ code: "TIMELINE_INSTANCE_UNSUPPORTED" });

    expect(audits).toEqual([
      expect.objectContaining({
        action: "timeline.connect",
        details: { mode: "external", hostname: null, outcome: "failure" },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("secret-key");
  });
});
