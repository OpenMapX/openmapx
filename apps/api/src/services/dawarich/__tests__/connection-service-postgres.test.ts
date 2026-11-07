import { timelineConnectionViewSchema } from "@openmapx/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "../../../db/auth-schema.js";
import { personalTimelineConnection } from "../../../db/timeline-connection-schema.js";
import { createMigratedPostgresFixture } from "../../../test/postgres-fixture.js";
import { encrypt } from "../../secrets.js";
import { currentUserFixture, settingsFixture } from "../__fixtures__/timeline-day.js";
import { DawarichClientError } from "../client.js";
import type {
  DrizzleTimelineConnectionStore,
  TimelineConnectionService,
} from "../connection-service.js";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../../../db/index.js", () => ({
  get db() {
    return state.fixture.db;
  },
}));
const USER_ID = "timeline-store-user";
function validClient() {
  return {
    getCurrentUser: vi.fn(async () => currentUserFixture),
    getSettings: vi.fn(async () => settingsFixture),
    getTimeline: vi.fn(async () => ({ days: [] })),
  };
}

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "timeline connection with actual PostgreSQL store",
  () => {
    let store: DrizzleTimelineConnectionStore;
    let ConnectionService: typeof TimelineConnectionService;
    beforeAll(async () => {
      state.fixture = await createMigratedPostgresFixture();
      const production = await import("../connection-service.js");
      store = new production.DrizzleTimelineConnectionStore();
      ConnectionService = production.TimelineConnectionService;
      await state.fixture.db.insert(user).values([
        { id: USER_ID, email: "timeline-store@example.test", name: "Fixture" },
        { id: "timeline-other-user", email: "timeline-other@example.test", name: "Other" },
      ]);
    }, 120_000);
    beforeEach(async () => {
      vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 7).toString("hex"));
      await state.fixture.db.delete(personalTimelineConnection);
      const encrypted = encrypt("stored-key");
      await state.fixture.db.insert(personalTimelineConnection).values({
        id: "timeline-store-connection",
        userId: USER_ID,
        mode: "external",
        publicOrigin: "https://timeline.example.test",
        displayName: "Fixture",
        encryptedApiKey: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        upstreamTimeZone: "Etc/UTC",
        status: "connected",
        consecutiveFailures: 0,
        validatedAt: new Date("2026-01-01T00:00:00Z"),
      });
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await state.fixture?.stop();
    });

    it("marks auth failures invalid, degrades only after three transient failures, then recovers", async () => {
      let failure: DawarichClientError | null = new DawarichClientError("unauthorized", 401);
      const service = new ConnectionService({
        store,
        audit: async () => {},
        recordMetric: () => {},
        clientFactory: () => {
          const client = validClient();
          if (failure) client.getCurrentUser.mockRejectedValueOnce(failure);
          return client;
        },
      });
      await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
        code: "TIMELINE_CREDENTIAL_INVALID",
      });
      expect(await store.findByUserId(USER_ID)).toMatchObject({
        status: "invalid",
        consecutiveFailures: 1,
      });
      await store.updateForUser(USER_ID, { status: "connected", consecutiveFailures: 0 });
      failure = new DawarichClientError("unavailable", 503);
      for (const expectedFailures of [1, 2, 3]) {
        await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
          code: "TIMELINE_UPSTREAM_UNAVAILABLE",
        });
        expect(await store.findByUserId(USER_ID)).toMatchObject({
          status: expectedFailures < 3 ? "connected" : "degraded",
          consecutiveFailures: expectedFailures,
        });
      }
      failure = null;
      await service.testConnection(USER_ID);
      expect(await store.findByUserId(USER_ID)).toMatchObject({
        status: "connected",
        consecutiveFailures: 0,
        upstreamEmail: "fixture@example.invalid",
      });
    });

    it("atomically counts concurrent transient failures before deriving connection status", async () => {
      let waitingClients = 0;
      const bothClientsWaiting = Promise.withResolvers<void>();
      const service = new ConnectionService({
        store,
        audit: async () => {},
        recordMetric: () => {},
        clientFactory: () => {
          const client = validClient();
          client.getCurrentUser.mockImplementationOnce(async () => {
            waitingClients += 1;
            if (waitingClients === 2) bothClientsWaiting.resolve();
            await bothClientsWaiting.promise;
            throw new DawarichClientError("unavailable", 503);
          });
          return client;
        },
      });
      const results = await Promise.allSettled([
        service.testConnection(USER_ID),
        service.testConnection(USER_ID),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await store.findByUserId(USER_ID)).toMatchObject({
        status: "connected",
        consecutiveFailures: 2,
      });
      await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
        code: "TIMELINE_UPSTREAM_UNAVAILABLE",
      });
      expect(await store.findByUserId(USER_ID)).toMatchObject({
        status: "degraded",
        consecutiveFailures: 3,
      });
    });

    it.each(["success", "credential_invalid"] as const)(
      "does not apply stale manual-test %s after the user switches connections",
      async (result) => {
        const encrypted = encrypt("new-key");
        let switched: Awaited<ReturnType<typeof store.findByUserId>> = null;
        const client = validClient();
        client.getTimeline.mockImplementationOnce(async () => {
          await store.updateForUser(USER_ID, {
            publicOrigin: "https://new.example",
            displayName: "New timeline",
            upstreamEmail: "new@example.invalid",
            encryptedApiKey: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
            status: "degraded",
            consecutiveFailures: 4,
          });
          switched = await store.findByUserId(USER_ID);
          if (result === "credential_invalid") throw new DawarichClientError("unauthorized", 401);
          return { days: [] };
        });
        const service = new ConnectionService({
          store,
          clientFactory: () => client,
          audit: async () => {},
          recordMetric: () => {},
        });
        if (result === "success") await service.testConnection(USER_ID);
        else
          await expect(service.testConnection(USER_ID)).rejects.toMatchObject({
            code: "TIMELINE_CREDENTIAL_INVALID",
          });
        expect(await store.findByUserId(USER_ID)).toEqual(switched!);
      },
    );

    it.each(["credential", "connection-id"] as const)(
      "does not apply stale read bookkeeping after %s changes",
      async (change) => {
        const service = new ConnectionService({ store, audit: async () => {} });
        const credential = await service.decryptConnectionCredential(USER_ID);
        if (change === "credential") {
          const encrypted = encrypt("new-read-key");
          await store.updateForUser(USER_ID, {
            encryptedApiKey: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
          });
        } else {
          const previous = (await store.findByUserId(USER_ID))!;
          await store.deleteForUser(USER_ID);
          await store.replaceForUser({ ...previous, id: "replacement-connection" });
        }
        await store.updateForUser(USER_ID, {
          publicOrigin: "https://new.example",
          displayName: "New timeline",
          status: "degraded",
          consecutiveFailures: 4,
          updatedAt: new Date("2026-02-01T00:00:00Z"),
        });
        const switched = await store.findByUserId(USER_ID);
        expect(
          await service.updateReadMetadata(USER_ID, credential.connectionSnapshot, {
            timeZone: "Europe/Berlin",
            distanceUnit: "mi",
          }),
        ).toBeNull();
        await service.recordReadFailure(
          USER_ID,
          credential.connectionSnapshot,
          "credential_invalid",
        );
        expect(await service.recordReadSuccess(USER_ID, credential.connectionSnapshot)).toBe(false);
        expect(await store.findByUserId(USER_ID)).toEqual(switched);
      },
    );

    it("reports a read-success CAS miss after the captured connection is disconnected", async () => {
      const service = new ConnectionService({ store, audit: async () => {} });
      const credential = await service.decryptConnectionCredential(USER_ID);
      await service.deleteConnection(USER_ID);
      expect(
        await service.updateReadMetadata(USER_ID, credential.connectionSnapshot, {
          timeZone: "Europe/Berlin",
          distanceUnit: "mi",
        }),
      ).toBeNull();
      expect(await service.recordReadSuccess(USER_ID, credential.connectionSnapshot)).toBe(false);
      expect(await store.findByUserId(USER_ID)).toBeNull();
    });

    it("applies read success after same-credential metadata refresh", async () => {
      const now = new Date("2026-02-01T00:00:00Z");
      const service = new ConnectionService({ store, audit: async () => {}, now: () => now });
      const credential = await service.decryptConnectionCredential(USER_ID);
      expect(
        await service.updateReadMetadata(USER_ID, credential.connectionSnapshot, {
          timeZone: "Europe/Berlin",
          distanceUnit: "mi",
        }),
      ).toEqual(credential.connectionSnapshot);
      expect(await service.recordReadSuccess(USER_ID, credential.connectionSnapshot)).toBe(true);
      expect(await store.findByUserId(USER_ID)).toMatchObject({
        upstreamTimeZone: "Europe/Berlin",
        distanceUnit: "mi",
        status: "connected",
        consecutiveFailures: 0,
        lastReadAt: now,
      });
    });

    it("scopes view, read-success and idempotent deletion to the supplied user", async () => {
      const first = (await store.findByUserId(USER_ID))!;
      await store.replaceForUser({
        ...first,
        id: "other-connection",
        userId: "timeline-other-user",
      });
      const service = new ConnectionService({ store, audit: async () => {} });
      const view = await service.getConnectionView(USER_ID);
      expect(timelineConnectionViewSchema.parse(view)).toEqual(view);
      expect(view.connection).toMatchObject({ displayName: "Fixture" });
      expect(JSON.stringify(view)).not.toMatch(/stored-key|encryption|encrypted/i);
      const credential = await service.decryptConnectionCredential(USER_ID);
      expect(await service.recordReadSuccess(USER_ID, credential.connectionSnapshot)).toBe(true);
      expect((await store.findByUserId(USER_ID))?.lastReadAt).toBeInstanceOf(Date);
      expect((await store.findByUserId("timeline-other-user"))?.lastReadAt).toBeNull();
      await service.deleteConnection(USER_ID);
      await service.deleteConnection(USER_ID);
      expect(await store.findByUserId(USER_ID)).toBeNull();
      expect(await store.findByUserId("timeline-other-user")).not.toBeNull();
    });
  },
);
